// Reward plan. All amounts are in pesewas (100 pesewas = GH₵1).
//  1. FIRST REFERRAL:  GH₵5 when the first person you referred (with your code) pays.
//  2. SECOND REFERRAL: GH₵5 more when a person you referred pays on your OTHER side (so GH₵10 in total).
//  3. EVERY OTHER PERSONAL REFERRAL: GH₵3 each time someone you referred pays, even if they ended up under someone else.
//  4. PAIR BONUS:      from then on, GH₵5 every time 1 NEW person joins your left side AND 1 NEW person joins your right
//                      side, even if you did not refer them. (Spillover and deeper members count.)
// Pair bonuses count people within the nearest MAX_LEVELS levels below you, which keeps the cost per sign-up bounded.
const FIRST_REFERRAL = 500;
const SECOND_REFERRAL = 500;
// WELCOME BONUS: paid to every new member the moment their first payment is confirmed. It is available to withdraw straight away
// (it skips the 12:00 am wait). Set WELCOME_BONUS_GHS to change it, or 0 to switch it off.
const WELCOME_BONUS = (() => { const v = process.env.WELCOME_BONUS_GHS; return v === undefined || String(v).trim() === '' ? 1000 : Math.round(Number(v) * 100); })();
const PERSONAL_BONUS = 300; // every OTHER personal referral (the first two are paid the bigger amounts above), even if they spill over
const CYCLE_BONUS = 500;
const CYCLE_PEOPLE_PER_SIDE = 1;
// With 1 left + 1 right a pair completes twice as often, so each level now costs about GH₵2.50 per sign-up. 10 levels keeps rewards near GH₵30 of each GH₵50.
const MAX_LEVELS = Number(process.env.REWARD_MAX_LEVELS || 10);

// Coins: every 3 people who join with YOUR code (paid members you sponsored, wherever they end up in the tree)
// earns you 1 coin. 3 coins convert to GH₵10.
const REFERRALS_PER_COIN = 3;
const COINS_PER_CASHOUT = 3;
const COIN_CASHOUT = 1000; // pesewas = GH₵10

module.exports = { WELCOME_BONUS, FIRST_REFERRAL, SECOND_REFERRAL, PERSONAL_BONUS, CYCLE_BONUS, CYCLE_PEOPLE_PER_SIDE, MAX_LEVELS, REFERRALS_PER_COIN, COINS_PER_CASHOUT, COIN_CASHOUT };
