/**
 * Format a numeric price (in smallest unit, e.g., INR) with a currency symbol.
 * For INR, short form uses Lakh/Crore abbreviations; otherwise full number.
 */
function formatPrice(price, symbol = '₹', shortForm = true) {
  if (price === null || price === undefined || isNaN(price)) return 'N/A';

  if (shortForm && symbol === '₹') {
    if (price >= 10000000) {
      return `${symbol}${(price / 10000000).toFixed(price % 10000000 === 0 ? 1 : 2)} Cr`;
    }
    if (price >= 100000) {
      return `${symbol}${(price / 100000).toFixed(price % 100000 === 0 ? 1 : 2)} L`;
    }
    return `${symbol}${price.toLocaleString('en-IN')}`;
  }

  return `${symbol}${price.toLocaleString('en-IN')}`;
}

module.exports = { formatPrice };