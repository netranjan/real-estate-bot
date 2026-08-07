// transport/whatsapp.js
// Unified WhatsApp Cloud API client. Auto-resolves credentials per lead.
// Replaces: whatsapp/send.js + whatsapp/payloads.js

const axios = require('axios');
const repo = require('../db/repository');

const API_BASE = 'https://graph.facebook.com/v25.0';

class WhatsAppClient {
  constructor(phoneNumberId, accessToken) {
    this.phoneNumberId = phoneNumberId;
    this.accessToken = accessToken;
  }

  // ── Factory: build client from lead's client_id ──
  static async forLead(lead) {
    const client = await repo.getClientById(lead.client_id);
    if (!client?.meta_phone_number_id || !client?.meta_access_token) {
      throw new Error(`WhatsApp credentials missing for client ${lead.client_id}`);
    }
    return new WhatsAppClient(client.meta_phone_number_id, client.meta_access_token);
  }

  // ── Raw send ──
  async _send(payload) {
    if (!this.phoneNumberId || !this.accessToken) {
      throw new Error('WhatsApp client not initialized with credentials');
    }
    const url = `${API_BASE}/${this.phoneNumberId}/messages`;
    try {
      await axios.post(url, payload, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
      });
      console.log('✅ Message sent to:', payload.to);
    } catch (error) {
      console.error('❌ Failed to send WhatsApp message:', error.response?.data || error.message);
      throw error;
    }
  }

  // ── High-level helpers ──
  async sendText(to, bodyText) {
    return this._send({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: bodyText },
    });
  }

  async sendButtons(to, bodyText, buttons, headerText = null) {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.slice(0, 3).map((btn) => ({
            type: 'reply',
            reply: {
              id: String(btn.id).slice(0, 256),
              title: String(btn.title).slice(0, 20),
            },
          })),
        },
      },
    };
    if (headerText) {
      payload.interactive.header = { type: 'text', text: headerText.slice(0, 60) };
    }
    return this._send(payload);
  }

  async sendList(to, bodyText, buttonText, sections, headerText = null, footerText = 'Select an option') {
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        footer: { text: footerText },
        action: {
          button: String(buttonText).slice(0, 20),
          sections: sections.map((sec) => ({
            title: String(sec.title).slice(0, 24),
            rows: (sec.rows || []).map((row) => ({
              id: String(row.id).slice(0, 200),
              title: String(row.title).slice(0, 24),
              description: row.description ? String(row.description).slice(0, 72) : undefined,
            })),
          })),
        },
      },
    };
    if (headerText) {
      payload.interactive.header = { type: 'text', text: headerText.slice(0, 60) };
    }
    return this._send(payload);
  }

  async sendDocument(to, documentUrl, filename) {
    return this._send({
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: {
        link: documentUrl,
        filename: String(filename || 'Document').slice(0, 255),
      },
    });
  }

  async sendImage(to, imageUrl, caption = '') {
    return this._send({
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { link: imageUrl, caption },
    });
  }

  async sendVideo(to, videoUrl, caption = '') {
    return this._send({
      messaging_product: 'whatsapp',
      to,
      type: 'video',
      video: { link: videoUrl, caption },
    });
  }
}

module.exports = WhatsAppClient;