const db = require('../db/queries');

async function requestCallback({ leadId, assignedAgentId, slaMinutes = 15 }) {
  const callback = await db.createCallbackRequest({
    leadId,
    assignedAgentId,
    slaMinutes,
  });

  console.log('📞 Callback requested:', callback.callback_request_id);
  return callback;
}

async function getPendingCallbacks(agentId) {
  return db.getPendingCallbacksForAgent(agentId);
}

module.exports = {
  requestCallback,
  getPendingCallbacks,
};