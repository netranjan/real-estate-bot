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

// ── NEW: Dynamic condition-based filtering ──
async function getFilteredProperties(clientId, conditions, leadAnswers) {
  // conditions = [{ field, operator, value }, ...]
  // leadAnswers = { budget_range: 'Above ₹1.5 Cr', configuration: '3BHK', ... }
  
  if (!conditions || conditions.length === 0) {
    return db.getPropertiesByClient(clientId);
  }

  const allProps = await db.getPropertiesByClient(clientId);
  
  return allProps.filter(prop => {
    return conditions.every(rule => {
      let fieldValue;
      
      // Resolve field source
      if (rule.field === 'budget_range') {
        // Compare against price_min / price_max
        const budget = parseBudgetRange(rule.value);
        if (rule.operator === 'between') {
          return prop.price_min >= budget.min && prop.price_max <= budget.max;
        }
        if (rule.operator === 'gte') return prop.price_min >= (parseFloat(rule.value) || 0);
        if (rule.operator === 'lte') return prop.price_max <= (parseFloat(rule.value) || Infinity);
        return true;
      }
      
      if (rule.field === 'configuration') {
        fieldValue = prop.configuration_types; // JSONB array
      } else if (rule.field === 'possession') {
        fieldValue = prop.possession_date ? 'future' : 'ready';
        if (prop.possession_date) {
          const d = new Date(prop.possession_date);
          fieldValue = d.getFullYear().toString();
        }
      } else {
        fieldValue = prop[rule.field];
      }
      
      // Resolve value (support {{variable}} from lead answers)
      let compareValue = rule.value;
      if (typeof compareValue === 'string' && compareValue.startsWith('{{') && compareValue.endsWith('}}')) {
        const varName = compareValue.slice(2, -2);
        compareValue = leadAnswers[varName] || '';
      }
      
      // Apply operator
      switch (rule.operator) {
        case 'eq': return String(fieldValue).toLowerCase() === String(compareValue).toLowerCase();
        case 'neq': return String(fieldValue).toLowerCase() !== String(compareValue).toLowerCase();
        case 'contains': {
          if (Array.isArray(fieldValue)) {
            return fieldValue.some(v => String(v).toLowerCase().includes(String(compareValue).toLowerCase()));
          }
          return String(fieldValue).toLowerCase().includes(String(compareValue).toLowerCase());
        }
        case 'gt': return parseFloat(fieldValue) > parseFloat(compareValue);
        case 'gte': return parseFloat(fieldValue) >= parseFloat(compareValue);
        case 'lt': return parseFloat(fieldValue) < parseFloat(compareValue);
        case 'lte': return parseFloat(fieldValue) <= parseFloat(compareValue);
        case 'in': {
          const vals = String(compareValue).split(',').map(v => v.trim().toLowerCase());
          if (Array.isArray(fieldValue)) {
            return fieldValue.some(v => vals.includes(String(v).toLowerCase()));
          }
          return vals.includes(String(fieldValue).toLowerCase());
        }
        default: return true;
      }
    });
  });
}

async function getMatchingProperties(clientId, answers) {
  const config = answers.configuration || null;
  const budget = parseBudgetRange(answers.budget_range);
  return db.filterProperties(clientId, config, budget.min, budget.max);
}

async function getPropertyDetails(propertyId) {
  const property = await db.getPropertyById(propertyId);
  if (!property) return null;
  const media = await db.getMediaForProperty(propertyId, 'brochure');
  const images = await db.getMediaForProperty(propertyId, 'image');
  return { ...property, brochures: media, images: images };
}

async function getBrochureUrl(propertyId) {
  const media = await db.getMediaForProperty(propertyId, 'brochure');
  return media.length > 0 ? media[0].asset_url : null;
}

module.exports = {
  parseBudgetRange,
  getMatchingProperties,
  getFilteredProperties,
  getPropertyDetails,
  getBrochureUrl,
};