const db = require('../db/queries');

// Budget range parser: "₹1.0 Cr – ₹1.2 Cr" → { min: 10000000, max: 12000000 }
function parseBudgetRange(budgetString) {
  if (!budgetString) return { min: null, max: null };

  const map = {
    '₹85 L – ₹1.0 Cr': { min: 8500000, max: 10000000 },
    '₹1.0 Cr – ₹1.2 Cr': { min: 10000000, max: 12000000 },
    '₹1.2 Cr – ₹1.5 Cr': { min: 12000000, max: 15000000 },
    'Above ₹1.5 Cr': { min: 15000000, max: 999999999 },
  };

  return map[budgetString] || { min: null, max: null };
}

async function getMatchingProperties(clientId, answers) {
  const config = answers.configuration || null;
  const budget = parseBudgetRange(answers.budget_range);

  return db.filterProperties(
    clientId,
    config,
    budget.min,
    budget.max
  );
}

async function getPropertyDetails(propertyId) {
  const property = await db.getPropertyById(propertyId);
  if (!property) return null;

  const media = await db.getMediaForProperty(propertyId, 'brochure');
  const images = await db.getMediaForProperty(propertyId, 'image');

  return {
    ...property,
    brochures: media,
    images: images,
  };
}

async function getBrochureUrl(propertyId) {
  const media = await db.getMediaForProperty(propertyId, 'brochure');
  return media.length > 0 ? media[0].asset_url : null;
}

module.exports = {
  parseBudgetRange,
  getMatchingProperties,
  getPropertyDetails,
  getBrochureUrl,
};