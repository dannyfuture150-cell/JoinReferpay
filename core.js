const crypto = require('crypto');
const { q, tx } = require('./db');
const { WELCOME_BONUS, MAX_LEVELS, FIRST_REFERRAL, SECOND_REFERRAL, PERSONAL_BONUS, CYCLE_BONUS, CYCLE_PEOPLE_PER_SIDE, REFERRALS_PER_COIN, COINS_PER_CASHOUT, COIN_CASHOUT } = require('./commissions');
const PATH_LIMIT = 1000; // how far up the tree we ever look

const now = () => new Date().toISOString();
// Paystack Ghana mobile money codes. Confirm in the Paystack docs if a transfer is rejected.
const NETWORKS = { MTN: 'MTN', TELECEL: 'VOD', AIRTELTIGO: 'ATL' };
const ph = (n, off = 0) => Array.from({ length: n }, (_, i) => '$' + (i + 1 + off)).join(',');
// Phone numbers are stored as 0551234567. Accept spaces, dashes, +233 and 233 as well.
const normPhone = (p) => {
  const s = String(p || '').replace(/[\s\-().]/g, '');
  return /^\+?233\d{9}$/.test(s) ? '0' + s.replace(/^\+?233/, '') : s;
};
const envNum = (v, d) => (v === undefined || String(v).trim() === '' ? d : Number(v)); // a blank setting means "use the default"
const isUnique = (e) => !!e && (e.code === '23505' || /unique/i.test(e.message || ''));

// c is a query function: q (normal) or the one given by tx() (inside a transaction).
const balanceOf = async (id, c = q) =>
  (await c('SELECT COALESCE(SUM(amount),0)::int AS b FROM ledger WHERE member_id=$1', [id])).rows[0].b;

// New earnings are PENDING until 12:00 am (midnight). Then they move into the member's available balance and can be withdrawn.
// (Ghana uses GMT all year, so midnight is UTC midnight. Set RELEASE_UTC_OFFSET_HOURS if you ever need a different clock.)
// For testing, REWARD_HOLD_HOURS switches to a rolling wait instead (for example 24 = a day after each reward, 0 = no wait).
const midnightMode = () => { const h = process.env.REWARD_HOLD_HOURS; return h === undefined || String(h).trim() === ''; };
function holdCutoff(nowMs = Date.now()) {
  if (!midnightMode()) return new Date(nowMs - Number(process.env.REWARD_HOLD_HOURS) * 3600e3).toISOString();
  const off = envNum(process.env.RELEASE_UTC_OFFSET_HOURS, 0) * 3600e3;
  const d = new Date(nowMs + off); d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - off).toISOString(); // the start of today: anything earned since then is still pending
}
// When the pending money is next released.
async function nextRelease(memberId) {
  const cutoff = holdCutoff();
  if (midnightMode()) return new Date(Date.parse(cutoff) + 24 * 3600e3).toISOString();
  const r = (await q("SELECT MIN(created) AS m FROM ledger WHERE member_id=$1 AND kind IN ('reward','bonus','cycle','coin_cash') AND created > $2", [memberId, cutoff])).rows[0].m;
  return r ? new Date(Date.parse(r) + Number(process.env.REWARD_HOLD_HOURS) * 3600e3).toISOString() : null;
}
// total = everything the member is owed, pending = earnings still waiting for 12:00 am,
// available = what they can withdraw right now.
async function balances(id, c = q) {
  const cutoff = holdCutoff();
  const r = (await c(`SELECT COALESCE(SUM(amount),0)::int AS total,
      COALESCE(SUM(CASE WHEN kind IN ('reward','bonus','cycle','coin_cash') AND created > $2 THEN amount ELSE 0 END),0)::int AS pending
    FROM ledger WHERE member_id=$1`, [id, cutoff])).rows[0];
  return { total: r.total, pending: r.pending, available: r.total - r.pending };
}

// Binary placement. The new member joins the sponsor's chosen side. If that spot is taken, they spill over
// to the first free spot further down that side (shallowest first, then oldest first).
async function place(c, sponsorId, side) {
  const first = (await c('SELECT id FROM members WHERE parent_id=$1 AND side=$2', [sponsorId, side])).rows[0];
  if (!first) return { parentId: sponsorId, side };
  const r = (await c(`
    WITH RECURSIVE s(id,depth) AS (
      SELECT id,0 FROM members WHERE parent_id=$1 AND side=$2
      UNION ALL SELECT m.id,s.depth+1 FROM members m JOIN s ON m.parent_id=s.id)
    SELECT s.id,
      EXISTS(SELECT 1 FROM members k WHERE k.parent_id=s.id AND k.side='L') AS has_l
    FROM s
    WHERE NOT (EXISTS(SELECT 1 FROM members k WHERE k.parent_id=s.id AND k.side='L')
           AND EXISTS(SELECT 1 FROM members k WHERE k.parent_id=s.id AND k.side='R'))
    ORDER BY s.depth, s.id LIMIT 1`, [sponsorId, side])).rows[0];
  return { parentId: r.id, side: r.has_l ? 'R' : 'L' };
}

// Marks a purchase paid and, on the member's FIRST paid purchase, pays the referral and pair bonuses to the members above them.
// Safe to call many times (webhook retries, return page): rewards are only created once.
async function fulfill(reference, amountPaid) {
  const p = (await q('SELECT * FROM purchases WHERE reference=$1', [reference])).rows[0];
  if (!p) return { ok: false, reason: 'unknown reference' };
  if (p.status === 'paid') return { ok: true, already: true };
  if (p.status === 'rejected') return { ok: false, reason: 'rejected' };
  if (amountPaid < p.amount) return { ok: false, reason: 'amount too low' };
  let earnedRows = [];
  await tx(async (c) => {
    const upd = await c("UPDATE purchases SET status='paid' WHERE id=$1 AND status IN ('pending','submitted')", [p.id]);
    if (upd.rowCount !== 1) return;
    const prior = (await c("SELECT COUNT(*)::int AS n FROM purchases WHERE member_id=$1 AND status='paid' AND id<>$2", [p.member_id, p.id])).rows[0].n;
    await c('UPDATE members SET active=1 WHERE id=$1', [p.member_id]);
    if (prior > 0) return; // only the first purchase triggers rewards
    if (WELCOME_BONUS > 0) { // the new member's own welcome bonus: not 'pending', so it can be withdrawn straight away
      await c("INSERT INTO ledger(member_id,kind,amount,ref,created) VALUES($1,'welcome',$2,$3,$4) ON CONFLICT (ref) DO NOTHING", [p.member_id, WELCOME_BONUS, 'welcome:' + p.member_id, now()]);
      earnedRows.push({ memberId: p.member_id, kind: 'welcome', amount: WELCOME_BONUS });
    }
    // Every member above the buyer, nearest first, in ONE query. path[0] is the buyer.
    const path = (await c(`
      WITH RECURSIVE up(id,parent_id,side,lvl) AS (
        SELECT id,parent_id,side,0 FROM members WHERE id=$1
        UNION ALL SELECT m.id,m.parent_id,m.side,up.lvl+1 FROM members m JOIN up ON m.id=up.parent_id WHERE up.lvl<$2)
      SELECT id,parent_id,side FROM up ORDER BY lvl`, [p.member_id, PATH_LIMIT])).rows;
    // anc[i].side = the side of that ancestor the buyer sits on (left or right)
    const anc = path.filter((r) => r.parent_id !== null).map((r, i) => ({ id: r.parent_id, side: r.side, level: i + 1 }));
    const sponsorId = (await c('SELECT sponsor_id FROM members WHERE id=$1', [p.member_id])).rows[0].sponsor_id;
    // The buyer counts toward the pair bonus of the nearest MAX_LEVELS members above them. The sponsor is always included.
    const within = anc.slice(0, MAX_LEVELS);
    const sponsor = anc.find((a) => a.id === sponsorId);
    const set = sponsor && !within.includes(sponsor) ? [...within, sponsor] : within;
    if (!set.length) return;
    const ids = set.map((a) => a.id);
    const info = {};
    (await c(`SELECT id,active,left_active,right_active,first_leg,bonus_stage,base_left,base_right,cycles_paid FROM members WHERE id IN (${ph(ids.length)})`, ids))
      .rows.forEach((r) => { info[r.id] = r; });
    const earn = [], ups = [];
    for (const a of set) {
      const m = info[a.id], counted = within.includes(a);
      const L = m.left_active + (counted && a.side === 'L' ? 1 : 0), R = m.right_active + (counted && a.side === 'R' ? 1 : 0);
      let stage = m.bonus_stage, firstLeg = m.first_leg, baseL = m.base_left, baseR = m.base_right, cycles = m.cycles_paid;
      if (m.active === 1) { // only members who have paid earn anything
        if (a.id === sponsorId) {
          if (stage === 0) { earn.push([a.id, 'bonus', FIRST_REFERRAL, `bonus1:${p.member_id}`, a.level]); stage = 1; firstLeg = a.side; }
          else if (stage === 1 && a.side !== firstLeg) { earn.push([a.id, 'bonus', SECOND_REFERRAL, `bonus2:${p.member_id}`, a.level]); stage = 2; baseL = L; baseR = R; }
          else earn.push([a.id, 'bonus', PERSONAL_BONUS, `bonus3:${p.member_id}`, a.level]); // every other personal referral, even a spillover one
        }
        if (m.bonus_stage === 2) { // pair bonuses only start once both referral bonuses were already earned
          const due = Math.min(Math.floor((L - baseL) / CYCLE_PEOPLE_PER_SIDE), Math.floor((R - baseR) / CYCLE_PEOPLE_PER_SIDE));
          for (let k = cycles + 1; k <= due; k++) earn.push([a.id, 'cycle', CYCLE_BONUS, `cycle:${a.id}:${k}`, a.level]);
          cycles = Math.max(cycles, due);
        }
      }
      ups.push([a.id, L, R, stage, firstLeg, baseL, baseR, cycles]);
    }
    for (const u of ups) await c('UPDATE members SET left_active=$2,right_active=$3,bonus_stage=$4,first_leg=$5,base_left=$6,base_right=$7,cycles_paid=$8 WHERE id=$1', u);
    if (!earn.length) return;
    earnedRows.push(...earn.map((e) => ({ memberId: e[0], kind: e[1], amount: e[2] })));
    const vals = [], params = [];
    earn.forEach((e, i) => {
      const o = i * 7;
      vals.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7})`);
      params.push(e[0], e[1], e[2], e[3], p.member_id, e[4], now());
    });
    await c(`INSERT INTO ledger(member_id,kind,amount,ref,src_id,level,created) VALUES ${vals.join(',')} ON CONFLICT (ref) DO NOTHING`, params);
  });
  return { ok: true, earned: earnedRows, buyerId: p.member_id }; // the server emails the people who earned
}

// Sign-up is paid BEFORE the account exists. The account is created here, only after Paystack confirms the payment.
// That payment is the member's first purchase, so it also rewards the active members above them.
// Safe to call repeatedly (webhook + return page): the account and rewards are created only once.
async function completeSignup(reference, amountPaid) {
  const s = (await q('SELECT * FROM signups WHERE reference=$1', [reference])).rows[0];
  if (!s) return { ok: false, reason: 'unknown reference' };
  if (amountPaid < s.amount) return { ok: false, reason: 'amount too low' };
  if (s.status === 'conflict') return { ok: false, reason: 'conflict' };
  if (s.status === 'rejected') return { ok: false, reason: 'rejected' };
  if (s.status !== 'completed' && !s.ref_code && process.env.REQUIRE_REFERRAL !== 'false'
      && (await q('SELECT COUNT(*)::int AS n FROM members')).rows[0].n > 0) return { ok: false, reason: 'noref' }; // would start a second, separate tree
  if (s.status !== 'completed') {
    for (let attempt = 0; ; attempt++) {
      try {
        await tx(async (c) => {
          const lock = await c("UPDATE signups SET status='completed' WHERE id=$1 AND status IN ('pending','submitted')", [s.id]);
          if (lock.rowCount !== 1) return;
          const sponsor = s.ref_code ? (await c('SELECT id FROM members WHERE code=$1', [s.ref_code])).rows[0] : null;
          const spot = sponsor ? await place(c, sponsor.id, s.side) : { parentId: null, side: null };
          let code;
          do { code = crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase(); }
          while ((await c('SELECT 1 FROM members WHERE code=$1', [code])).rows.length);
          const m = await c(`INSERT INTO members(name,email,phone,network,pass_hash,code,parent_id,sponsor_id,side,created)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [s.name, s.email, s.phone, s.network, s.pass_hash, code, spot.parentId, sponsor ? sponsor.id : null, spot.side, now()]);
          const memberId = m.rows[0].id;
          await c('UPDATE signups SET member_id=$1 WHERE id=$2', [memberId, s.id]);
          await c('INSERT INTO purchases(member_id,reference,amount,status,created) VALUES($1,$2,$3,$4,$5)', [memberId, reference, s.amount, 'pending', now()]);
        });
        break;
      } catch (e) {
        if (!isUnique(e)) throw e;
        if ((await q('SELECT 1 FROM members WHERE phone=$1', [s.phone])).rows.length) {
          // Someone registered this phone number while this payment was in progress. Needs a manual refund.
          await q("UPDATE signups SET status='conflict' WHERE id=$1", [s.id]);
          console.error('SIGNUP CONFLICT, refund needed for payment', reference);
          return { ok: false, reason: 'conflict' };
        }
        if (attempt >= 4) throw e; // otherwise two people grabbed the same tree spot at once: try again
      }
    }
  }
  return fulfill(reference, amountPaid); // activates the member and pays the levels above (idempotent)
}

// Routes a confirmed payment to the right handler: a new sign-up, or a payment by an existing member.
async function processPayment(reference, amountPaid) {
  if ((await q('SELECT 1 FROM signups WHERE reference=$1', [reference])).rows.length) return completeSignup(reference, amountPaid);
  return fulfill(reference, amountPaid);
}

// Creates a new (not yet activated) member and places them in the tree on the sponsor's chosen side.
// Returns { id } or { error: 'phone' } if that phone number is already registered.
async function createMember({ name, email, phone, network, passHash, sponsorId, side }) {
  for (let attempt = 0; ; attempt++) {
    try {
      const id = await tx(async (c) => {
        const spot = sponsorId ? await place(c, sponsorId, side) : { parentId: null, side: null };
        let code;
        do { code = crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase(); }
        while ((await c('SELECT 1 FROM members WHERE code=$1', [code])).rows.length);
        const r = await c(`INSERT INTO members(name,email,phone,network,pass_hash,code,parent_id,sponsor_id,side,created)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [name, email, phone, network, passHash, code, spot.parentId, sponsorId || null, spot.side, now()]);
        return r.rows[0].id;
      });
      return { id };
    } catch (e) {
      if (!isUnique(e)) throw e;
      if ((await q('SELECT 1 FROM members WHERE phone=$1', [phone])).rows.length) return { error: 'phone' };
      if (attempt >= 4) throw e; // otherwise two people grabbed the same tree spot at once: try again
    }
  }
}

// Returns a failed withdrawal's money to the member's balance (only once, and never for a withdrawal that was paid).
async function refundPayout(id) {
  const p = (await q('SELECT * FROM payouts WHERE id=$1', [id])).rows[0];
  if (!p || p.status === 'paid') return;
  await q("UPDATE payouts SET status='failed' WHERE id=$1 AND status IN ('processing','pending')", [id]);
  await q('INSERT INTO ledger(member_id,kind,amount,ref,created) VALUES($1,$2,$3,$4,$5) ON CONFLICT (ref) DO NOTHING',
    [p.member_id, 'payout_refund', p.amount, 'refund:' + id, now()]);
}

// Instant withdrawal to the member's mobile money, straight from the Paystack balance.
// The amount is taken off the member's balance FIRST (the member row is locked, so two clicks can never spend
// it twice), then the transfer is sent. If Paystack definitely did not accept it, the money goes back.
// If it is unclear (e.g. a network error after sending), nothing is refunded and the Paystack webhook decides.
// Takes a withdrawal off the member's balance and records it. Shared by instant (Paystack) and manual withdrawals.
async function holdPayout(memberId, gross, { fee, min, status, reference, number, network }) {
  if (!Number.isInteger(gross) || gross < min || gross - fee < 100) return { ok: false, code: 'min' };
  const who = (await q('SELECT active,phone,network FROM members WHERE id=$1', [memberId])).rows[0];
  if (!who || !who.active) return { ok: false, code: 'inactive' };
  const toNumber = number || who.phone, toNetwork = network || who.network; // the member chooses where the money goes
  const got = await tx(async (c) => {
    await c('SELECT id FROM members WHERE id=$1 FOR UPDATE', [memberId]);
    const b = await balances(memberId, c);
    if (b.available < gross) return { code: b.total >= gross ? 'pending' : 'balance' }; // 'pending' = still in the waiting period
    const r = await c('INSERT INTO payouts(member_id,amount,fee,status,reference,momo_number,momo_network,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [memberId, gross, fee, status, reference, toNumber, toNetwork, now()]);
    const pid = r.rows[0].id;
    await c('INSERT INTO ledger(member_id,kind,amount,ref,created) VALUES($1,$2,$3,$4,$5)', [memberId, 'payout_hold', -gross, 'hold:' + pid, now()]);
    return { id: pid };
  });
  if (!got.id) return { ok: false, code: got.code };
  return { ok: true, id: got.id };
}

// MANUAL mode: the withdrawal waits for the merchant, who sends the money by hand and then marks it paid.
const requestWithdrawal = (memberId, gross, { fee, min, number, network }) => holdPayout(memberId, gross, { fee, min, status: 'pending', reference: null, number, network });
async function markPayoutPaid(id) {
  return (await q("UPDATE payouts SET status='paid' WHERE id=$1 AND status='pending'", [id])).rowCount === 1;
}

// MANUAL mode sign-ups: the person sends the money by MoMo and gives the transaction ID. The merchant then approves.
async function submitSignupPayment(reference, txnId, phone) {
  const s = (await q('SELECT * FROM signups WHERE reference=$1', [reference])).rows[0];
  // The phone number must match the one used to sign up, so nobody can tamper with someone else's payment reference.
  if (!s || s.phone !== normPhone(phone)) return { code: 'unknown' };
  if (!['pending', 'submitted'].includes(s.status)) return { code: 'closed' };
  if ((await q('SELECT 1 FROM signups WHERE txn_id=$1 AND id<>$2', [txnId, s.id])).rows.length) return { code: 'dup' };
  try { await q("UPDATE signups SET txn_id=$1, status='submitted' WHERE id=$2", [txnId, s.id]); }
  catch (e) { if (isUnique(e)) return { code: 'dup' }; throw e; } // two people entered the same ID at once
  return { ok: true, signup: s };
}
async function rejectSignup(id) {
  return (await q("UPDATE signups SET status='rejected' WHERE id=$1 AND status IN ('pending','submitted')", [id])).rowCount === 1;
}

// MANUAL mode, for an account that exists but has not paid yet (for example one made before payment was moved into sign-up):
// the member sends the money by MoMo and gives the transaction ID, and the merchant approves it in the admin page.
async function submitActivationPayment(memberId, txnId, amount) {
  const m = (await q('SELECT id,active FROM members WHERE id=$1', [memberId])).rows[0];
  if (!m) return { code: 'unknown' };
  if (m.active) return { code: 'active' };
  if ((await q('SELECT 1 FROM signups WHERE txn_id=$1 UNION SELECT 1 FROM purchases WHERE txn_id=$1 AND member_id<>$2', [txnId, memberId])).rows.length) return { code: 'dup' };
  let p = (await q("SELECT * FROM purchases WHERE member_id=$1 AND status IN ('pending','submitted') ORDER BY id DESC LIMIT 1", [memberId])).rows[0];
  if (!p) {
    const reference = 'RA' + crypto.randomInt(100000, 999999) + crypto.randomBytes(2).toString('hex');
    p = (await q('INSERT INTO purchases(member_id,reference,amount,status,created) VALUES($1,$2,$3,$4,$5) RETURNING *', [memberId, reference, amount, 'pending', now()])).rows[0];
  }
  try { await q("UPDATE purchases SET txn_id=$1, status='submitted' WHERE id=$2", [txnId, p.id]); }
  catch (e) { if (isUnique(e)) return { code: 'dup' }; throw e; }
  return { ok: true, purchase: p };
}
// The owner's own (first) account does not have to pay the merchant, which is the owner. Only an unpaid account at the very top of
// the tree (no one above it) can be switched on this way, so nobody can skip paying while sitting under someone else.
async function activateRoot(id) {
  return (await q('UPDATE members SET active=1 WHERE id=$1 AND active=0 AND parent_id IS NULL', [id])).rowCount === 1;
}
async function rejectActivation(id) {
  return (await q("UPDATE purchases SET status='rejected' WHERE id=$1 AND status='submitted'", [id])).rowCount === 1;
}

// INSTANT mode: withdraw from the Paystack balance.
async function withdraw(memberId, gross, { ps, fee, min, number, network }) {
  const reference = 'rp_payout_' + crypto.randomBytes(8).toString('hex');
  const held = await holdPayout(memberId, gross, { fee, min, status: 'processing', reference, number, network });
  if (!held.ok) return held;
  const id = held.id;
  const m = (await q('SELECT * FROM members WHERE id=$1', [memberId])).rows[0];
  try {
    const to = number || m.phone, net = network || m.network, same = to === m.phone && net === m.network;
    let code = same ? m.recipient_code : null; // a different number gets its own one-off recipient
    if (!code) {
      const rec = await ps.recipient({ type: 'mobile_money', name: m.name, account_number: to, bank_code: NETWORKS[net], currency: 'GHS' });
      code = rec.recipient_code;
      if (same) await q('UPDATE members SET recipient_code=$1 WHERE id=$2', [code, memberId]);
    }
    const t = await ps.transfer({ source: 'balance', amount: gross - fee, recipient: code, reference, reason: 'ReferPay withdrawal', currency: 'GHS' });
    if (t.status === 'otp') throw new Error('Paystack wants an OTP. Turn off "Confirm transfers before sending" in Paystack Preferences.');
    if (t.status === 'success') await q("UPDATE payouts SET status='paid' WHERE id=$1", [id]);
    return { ok: true, id, status: t.status };
  } catch (e) {
    console.error('withdrawal error:', e.message);
    let known = null;
    try { known = await ps.verifyTransfer(reference); } catch (_) { /* Paystack has no such transfer */ }
    if (known && ['success', 'pending', 'processing', 'received'].includes(known.status)) return { ok: true, id, status: known.status };
    await refundPayout(id);
    return { ok: false, code: 'unavailable' };
  }
}

// Coins are worked out from the member's own referrals, so they can never get out of step:
// coins earned = (paid people sponsored with this member's code) / 3, rounded down.
// Cashing out 3 coins writes one 'coin_cash' ledger row, so converted coins = 3 x those rows.
async function coinStatus(memberId, c = q) {
  const refs = (await c('SELECT COUNT(*)::int AS n FROM members WHERE sponsor_id=$1 AND active=1', [memberId])).rows[0].n;
  const k = (await c("SELECT COUNT(*)::int AS n FROM ledger WHERE member_id=$1 AND kind='coin_cash'", [memberId])).rows[0].n;
  const earned = Math.floor(refs / REFERRALS_PER_COIN), converted = k * COINS_PER_CASHOUT;
  return { referrals: refs, earned, converted, available: earned - converted, nextIn: REFERRALS_PER_COIN - (refs % REFERRALS_PER_COIN) };
}

// Turns every full group of 3 available coins into GH₵5 on the member's balance (inside the usual 24-hour wait).
async function convertCoins(memberId) {
  const out = await tx(async (c) => {
    await c('SELECT id FROM members WHERE id=$1 FOR UPDATE', [memberId]);
    const who = (await c('SELECT active FROM members WHERE id=$1', [memberId])).rows[0];
    if (!who || !who.active) return { code: 'inactive' };
    const st = await coinStatus(memberId, c);
    const groups = Math.floor(st.available / COINS_PER_CASHOUT);
    if (groups < 1) return { code: 'coins' };
    const k = st.converted / COINS_PER_CASHOUT, vals = [], params = [];
    for (let i = 1; i <= groups; i++) {
      const o = (i - 1) * 4;
      vals.push(`($${o + 1},'coin_cash',$${o + 2},$${o + 3},$${o + 4})`);
      params.push(memberId, COIN_CASHOUT, `coins:${memberId}:${k + i}`, now());
    }
    await c(`INSERT INTO ledger(member_id,kind,amount,ref,created) VALUES ${vals.join(',')} ON CONFLICT (ref) DO NOTHING`, params);
    return { groups, amount: groups * COIN_CASHOUT };
  });
  return out.code ? { ok: false, code: out.code } : { ok: true, ...out };
}

// Lifetime withdrawals for the Home page: paid = taken off the balance and sent, received = after fees,
// waiting = requested but not yet sent. Failed or rejected (refunded) withdrawals are not counted.
async function withdrawalTotals(memberId) {
  return (await q(`SELECT COALESCE(SUM(CASE WHEN status='paid' THEN amount END),0)::int AS paid,
      COALESCE(SUM(CASE WHEN status='paid' THEN amount - fee END),0)::int AS received,
      COALESCE(SUM(CASE WHEN status IN ('pending','processing') THEN amount END),0)::int AS waiting
    FROM payouts WHERE member_id=$1`, [memberId])).rows[0];
}

// ---- Catch-up: bring earnings from sign-ups made under an older plan in line with the current one ----
//  - a personal referral that never paid its sponsor anything now pays PERSONAL_BONUS
//  - a pair bonus that was paid at an older, lower rate is topped up to CYCLE_BONUS
// Each correction has its own unique reference, so applying it twice never pays twice. Credits join the usual 12:00 am release.
async function trueUp(apply = false) {
  return tx(async (c) => {
    const personal = (await c(`SELECT m.id AS buyer, m.sponsor_id AS sponsor FROM members m JOIN members s ON s.id=m.sponsor_id
      WHERE m.active=1 AND s.active=1
        AND NOT EXISTS (SELECT 1 FROM ledger l WHERE l.src_id=m.id AND l.member_id=m.sponsor_id AND l.kind='bonus')`)).rows;
    const cycles = (await c(`SELECT l.id, l.member_id, l.src_id, l.amount FROM ledger l
      WHERE l.kind='cycle' AND l.amount < $1 AND l.ref NOT LIKE 'fixcycle:%'
        AND NOT EXISTS (SELECT 1 FROM ledger f WHERE f.ref = 'fixcycle:' || l.id)`, [CYCLE_BONUS])).rows;
    if (apply) {
      const ins = 'INSERT INTO ledger(member_id,kind,amount,ref,src_id,level,created) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (ref) DO NOTHING';
      for (const p of personal) await c(ins, [p.sponsor, 'bonus', PERSONAL_BONUS, `bonus3:${p.buyer}`, p.buyer, null, now()]);
      for (const r of cycles) await c(ins, [r.member_id, 'cycle', CYCLE_BONUS - r.amount, `fixcycle:${r.id}`, r.src_id, null, now()]);
    }
    return {
      personal: { count: personal.length, total: personal.length * PERSONAL_BONUS },
      cycles: { count: cycles.length, total: cycles.reduce((a, r) => a + CYCLE_BONUS - r.amount, 0) },
      members: new Set([...personal.map((p) => p.sponsor), ...cycles.map((r) => r.member_id)]).size,
    };
  });
}

// ---- Password reset: a short code sent by text and email (or given by the merchant), valid for a few minutes ----
const codeHash = (memberId, code) => crypto.createHmac('sha256', process.env.SESSION_SECRET || '').update(memberId + ':' + code).digest('hex');
async function createResetCode(memberId, minutes = 15, skipLimit = false) {
  const since = new Date(Date.now() - 3600e3).toISOString();
  if (!skipLimit && (await q('SELECT COUNT(*)::int AS n FROM password_resets WHERE member_id=$1 AND created > $2', [memberId, since])).rows[0].n >= 3) return { error: 'rate' };
  await q('UPDATE password_resets SET used=1 WHERE member_id=$1 AND used=0', [memberId]); // only the newest code works
  const code = String(crypto.randomInt(100000, 1000000));
  await q('INSERT INTO password_resets(member_id,code_hash,expires,created) VALUES($1,$2,$3,$4)',
    [memberId, codeHash(memberId, code), new Date(Date.now() + minutes * 60e3).toISOString(), now()]);
  return { code };
}
// Checks the code (5 tries per code), sets the new password, and signs the member out everywhere (token_ver + 1).
async function completeReset(memberId, code, passHash) {
  return tx(async (c) => {
    const r = (await c('SELECT * FROM password_resets WHERE member_id=$1 AND used=0 ORDER BY id DESC LIMIT 1 FOR UPDATE', [memberId])).rows[0];
    if (!r || r.expires < now() || r.attempts >= 5) return { ok: false };
    if (!crypto.timingSafeEqual(Buffer.from(r.code_hash, 'hex'), Buffer.from(codeHash(memberId, String(code)), 'hex'))) {
      await c('UPDATE password_resets SET attempts=attempts+1 WHERE id=$1', [r.id]);
      return { ok: false };
    }
    await c('UPDATE members SET pass_hash=$2, token_ver=token_ver+1 WHERE id=$1', [memberId, passHash]);
    await c('UPDATE password_resets SET used=1 WHERE member_id=$1', [memberId]);
    return { ok: true };
  });
}

// Everyone below a member at any depth, combined, with which side (leg) they are on, whether the member
// sponsored them directly, and how much the member earned from them.
async function downlines(id) {
  return (await q(`
    WITH RECURSIVE d(id,name,active,lvl,leg,direct,parent_id,side) AS (
      SELECT id,name,active,1,side,(sponsor_id=$1),parent_id,side FROM members WHERE parent_id=$1
      UNION ALL SELECT m.id,m.name,m.active,d.lvl+1,d.leg,(m.sponsor_id=$1),m.parent_id,m.side FROM members m JOIN d ON m.parent_id=d.id)
    SELECT d.*, COALESCE((SELECT SUM(amount) FROM ledger WHERE member_id=$1 AND src_id=d.id AND kind IN ('reward','bonus','cycle')),0)::int AS earned
    FROM d ORDER BY leg,lvl,name`, [id])).rows;
}

module.exports = { trueUp, createResetCode, completeReset, normPhone, envNum, NETWORKS, now, balanceOf, balances, holdCutoff, nextRelease, midnightMode, place, fulfill, completeSignup, processPayment, createMember, refundPayout, withdraw, downlines, coinStatus, convertCoins, withdrawalTotals, submitActivationPayment, rejectActivation, activateRoot, requestWithdrawal, markPayoutPaid, submitSignupPayment, rejectSignup };
