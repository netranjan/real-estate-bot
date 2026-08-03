const axios = require('axios');

const API_BASE = 'https://graph.facebook.com/v25.0';

async function sendWhatsAppMessage({ phoneNumberId, accessToken, payload }) {
  if (!phoneNumberId || !accessToken) {
    console.error('❌ Missing phoneNumberId or accessToken');
    return;
  }

  const url = `${API_BASE}/${phoneNumberId}/messages`;

  try {
    await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    console.log('✅ Message sent to:', payload.to);
  } catch (error) {
    console.error('❌ Failed to send WhatsApp message:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = sendWhatsAppMessage;