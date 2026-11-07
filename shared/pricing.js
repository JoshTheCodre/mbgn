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
