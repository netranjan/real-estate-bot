const db = require('../db/queries');

// Score rules: field_name => { value => points }
const SCORE_RULES = {
  requirement_type: {
    'Buy for Self-Use': 20,
    'Investment / Rent': 15,
  },
  configuration: {
    '2 BHK': 10,
    '3 BHK': 20,
    '3.5 BHK / Duplex': 25,
    'Penthouse / Custom': 30,
  },
  budget_range: {
    '₹85 L – ₹1.0 Cr': 10,
    '₹1.0 Cr – ₹1.2 Cr': 15,
    '₹1.2 Cr – ₹1.5 Cr': 20,
    'Above ₹1.5 Cr': 25,
  },
  timeline: {
    'Ready to Move': 30,
    '1 Year': 20,
    '2+ Years': 10,
  },
};

// Bonus for having a selected property
const SELECTED_PROPERTY_BONUS = 10;
// Bonus for booking a site visit
const SITE_VISIT_BONUS = 15;
// Bonus for requesting callback (high intent)
const CALLBACK_BONUS = 10;

async function calculateLeadScore(leadId) {
  const answers = await db.getLeadAnswers(leadId);
  const lead = await db.getLeadById(leadId);

  let score = 0;

  // Base score from answers
  for (const ans of answers) {
    const rules = SCORE_RULES[ans.field_name];
    if (rules && rules[ans.field_value]) {
      score += rules[ans.field_value];
    }
  }

  // Property selected bonus
  if (lead.context_data?.selected_property_id) {
    score += SELECTED_PROPERTY_BONUS;
  }

  // Site visit booked bonus
  const visits = await db.getSiteVisitsForLead(leadId);
  if (visits.length > 0) {
    score += SITE_VISIT_BONUS;
  }

  // Callback requested bonus
  // (We check this via lead_history or pipeline stage)
  if (lead.pipeline_stage === 'Callback Requested') {
    score += CALLBACK_BONUS;
  }

  // Cap at 100
  score = Math.min(score, 100);

  await db.updateLeadScore(leadId, score);
  return score;
}

module.exports = {
  calculateLeadScore,
  SCORE_RULES,
};