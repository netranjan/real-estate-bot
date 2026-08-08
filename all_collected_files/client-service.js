const db = require('../db/queries');

async function listClients(search) {
  return db.getAllClients(search);
}

async function getClient(clientId) {
  return db.getClientByIdIncludingInactive(clientId);
}

async function createClient(data) {
  return db.createClient(data);
}

async function updateClient(clientId, data) {
  return db.updateClient(clientId, data);
}

async function toggleClientActive(clientId) {
  const client = await db.getClientByIdIncludingInactive(clientId);
  if (!client) throw new Error('Client not found');
  return db.updateClient(clientId, { active: !client.active });
}

async function getClientStats(clientId) {
  const [leads, properties, flows, agents] = await Promise.all([
    db.countLeadsByClient(clientId),
    db.countPropertiesByClient(clientId),
    db.countFlowsByClient(clientId),
    db.countAgentsByClient(clientId)
  ]);
  return { leads, properties, flows, agents };
}

async function getClientRecentActivity(clientId) {
  const [recentLeads, recentVisits, recentCallbacks] = await Promise.all([
    db.getLeadsByClient(clientId, 10),
    db.getRecentSiteVisitsByClient(clientId, 10),
    db.getRecentCallbacksByClient(clientId, 10)
  ]);
  return { recentLeads, recentVisits, recentCallbacks };
}

module.exports = {
  listClients,
  getClient,
  createClient,
  updateClient,
  toggleClientActive,
  getClientStats,
  getClientRecentActivity
};