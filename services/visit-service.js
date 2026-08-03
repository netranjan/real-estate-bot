const db = require('../db/queries');

async function getAvailableSlots(propertyId) {
  return db.getVisitOptionsForProperty(propertyId);
}

async function bookVisit({ leadId, propertyId, visitOptionId, agentId = null }) {
  // If no agent assigned, this can be handled by assign-agent executor first
  const visit = await db.createSiteVisit({
    leadId,
    propertyId,
    visitOptionId,
    agentId,
  });

  console.log('📅 Site visit booked:', visit.site_visit_id);
  return visit;
}

async function getLeadVisits(leadId) {
  return db.getSiteVisitsForLead(leadId);
}

module.exports = {
  getAvailableSlots,
  bookVisit,
  getLeadVisits,
};