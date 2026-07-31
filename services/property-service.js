const db = require('../db/queries');

// Budget range parser: "₹1.0 Cr – ₹1.2 Cr" → { min: 10000000, max: 12000000 }
function parseBudgetRange(budgetString) {
  if (!budgetString) return { min: 0, max: Infinity };
  const map = {
    '₹85 L – ₹1.0 Cr': { min: 8500000, max: 10000000 },
    '₹1.0 Cr – ₹1.2 Cr': { min: 10000000, max: 12000000 },
    '₹1.2 Cr – ₹1.5 Cr': { min: 12000000, max: 15000000 },
    'Above ₹1.5 Cr': { min: 15000000, max: 999999999 },
  };
  return map[budgetString] || { min: 0, max: Infinity };
}

// ── NEW: Smart filtering based on lead answers + admin-selected dimensions ──
async function getSmartFilteredProperties(clientId, leadAnswers, matchDimensions) {
  // leadAnswers = { budget_range: '₹1.0 Cr – ₹1.2 Cr', configuration: '3BHK', ... }
  // matchDimensions = ['budget_range', 'configuration'] (from admin checkboxes)
  
  if (!matchDimensions || matchDimensions.length === 0) {
    return db.getPropertiesByClient(clientId);
  }

  const allProps = await db.getPropertiesByClient(clientId);
  
  return allProps.filter(prop => {
    // Must pass ALL dimensions that have lead answers
    return matchDimensions.every(dim => {
      const leadValue = leadAnswers[dim];
      
      // If lead hasn't answered this question yet, don't filter by it
      if (!leadValue || String(leadValue).trim() === '') return true;
      
      switch (dim) {
        case 'budget_range': {
          const budget = parseBudgetRange(leadValue);
          // Property price range overlaps with lead budget
          return prop.price_min <= budget.max && prop.price_max >= budget.min;
        }
        
        case 'configuration': {
          const configs = prop.configuration_types || [];
          const want = String(leadValue).toLowerCase();
          return configs.some(c => String(c).toLowerCase() === want);
        }
        
        case 'possession': {
          const val = String(leadValue).toLowerCase();
          if (val === 'ready' || val === 'immediate') {
            // Ready = no possession date, or date is today or past
            if (!prop.possession_date) return true;
            return new Date(prop.possession_date) <= new Date();
          }
          // Year-based: "2026"
          const year = parseInt(leadValue);
          if (year && prop.possession_date) {
            return new Date(prop.possession_date).getFullYear() === year;
          }
          return true;
        }
        
        case 'location': {
          const haystack = String(prop.location || prop.property_name || '').toLowerCase();
          return haystack.includes(String(leadValue).toLowerCase());
        }
        
        default:
          return true;
      }
    });
  });
}

// ── OLD: Keep for backward compatibility with existing flows ──
async function getFilteredProperties(clientId, conditions, leadAnswers) {
  if (!conditions || conditions.length === 0) {
    return db.getPropertiesByClient(clientId);
  }

  const allProps = await db.getPropertiesByClient(clientId);
  
  return allProps.filter(prop => {
    return conditions.every(rule => {
      let fieldValue;
      
      if (rule.field === 'budget_range') {
        const budget = parseBudgetRange(rule.value);
        if (rule.operator === 'between') {
          return prop.price_min >= budget.min && prop.price_max <= budget.max;
        }
        if (rule.operator === 'gte') return prop.price_min >= (parseFloat(rule.value) || 0);
        if (rule.operator === 'lte') return prop.price_max <= (parseFloat(rule.value) || Infinity);
        return true;
      }
      
      if (rule.field === 'configuration') {
        fieldValue = prop.configuration_types;
      } else if (rule.field === 'possession') {
        fieldValue = prop.possession_date ? 'future' : 'ready';
        if (prop.possession_date) {
          const d = new Date(prop.possession_date);
          fieldValue = d.getFullYear().toString();
        }
      } else {
        fieldValue = prop[rule.field];
      }
      
      let compareValue = rule.value;
      if (typeof compareValue === 'string' && compareValue.startsWith('{{') && compareValue.endsWith('}}')) {
        const varName = compareValue.slice(2, -2);
        compareValue = leadAnswers[varName] || '';
      }
      
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
  getSmartFilteredProperties,
  getPropertyDetails,
  getBrochureUrl,
};