// Used by the server to charge and by the vote page to show prices, so the two always agree.

// Bulk deals work as tiers: from a deal's number of votes upwards, every vote costs that deal's
// rate, so 70 votes on a "50 for 8,000" deal cost 70 x 160.
export function bulkPrice(votes, votePrice, packages) {
  const deal = packages.filter((p) => p.votes <= votes).sort((a, b) => b.votes - a.votes)[0];
  // A deal never costs more than paying the normal price, even after the price per vote drops.
  const rate = deal ? Math.min(votePrice, deal.price / deal.votes) : votePrice;
  return Math.round(votes * rate);
}

// What to suggest to someone about to pay for `votes`: the next deals up, or once past the biggest
// deal, the next step of that size. There is always something bigger to offer.
export function upsellOffers(votes, votePrice, packages) {
  const sizes = packages.map((p) => p.votes).filter((n) => n > votes).sort((a, b) => a - b).slice(0, 2);
  if (sizes.length === 0) {
    const step = Math.max(10, ...packages.map((p) => p.votes));
    sizes.push((Math.floor(votes / step) + 1) * step);
  }
  const now = bulkPrice(votes, votePrice, packages);
  return sizes.map((size) => {
    const price = bulkPrice(size, votePrice, packages);
    return { votes: size, price, extra: price - now, saving: Math.max(0, size * votePrice - price) };
  });
}

// Paystack's fee, paid by the voter on top of the votes. Worked out so that once Paystack takes its
// fee from the total, the whole vote amount is left.
// - Nigeria: 1.5% + NGN 100, the NGN 100 waived under NGN 2,500, never more than NGN 2,000. Whole naira.
// - Ghana: 1.95% on local payments (Mobile Money included). To the pesewa.
// Ghana before its own Paystack account: a card payment through Nigeria's account, charged in
// naira at the rate the admin sets (naira per cedi). Paystack Nigeria's fee on a card from outside
// Nigeria is 3.9% + NGN 100, paid by the voter. Whole naira.
export function cardChargeNgn(amount, rate) {
  const amountNgn = Math.ceil(amount * rate);
  const totalNgn = Math.ceil((amountNgn + 100) / 0.961);
  return { amountNgn, feeNgn: totalNgn - amountNgn, totalNgn };
}

export function paymentCharges(amount, country = 'ng') {
  if (country === 'gh') {
    const pesewas = Math.round(amount * 100);
    return (Math.ceil(pesewas / 0.9805) - pesewas) / 100;
  }
  let total = Math.ceil(amount / 0.985);
  if (total >= 2500) total = Math.ceil((amount + 100) / 0.985);
  return Math.min(total - amount, 2000);
}
