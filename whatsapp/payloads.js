function buttonMessage(to, bodyText, buttons, headerText = null) {
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
          reply: { id: String(btn.id).slice(0, 256), title: String(btn.title).slice(0, 20) },
        })),
      },
    },
  };

  if (headerText) {
    payload.interactive.header = { type: 'text', text: headerText.slice(0, 60) };
  }

  return payload;
}

function listMessage(to, bodyText, buttonText, sections, headerText = null, footerText = 'Select an option') {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      footer: { text: footerText },
      action: { button: buttonText.slice(0, 20), sections },
    },
  };

  if (headerText) {
    payload.interactive.header = { type: 'text', text: headerText.slice(0, 60) };
  }

  return payload;
}

function textMessage(to, bodyText) {
  return { messaging_product: 'whatsapp', to, type: 'text', text: { body: bodyText } };
}

function imageMessage(to, imageUrl, caption = '') {
  return { messaging_product: 'whatsapp', to, type: 'image', image: { link: imageUrl, caption } };
}

function documentMessage(to, documentUrl, filename) {
  return { messaging_product: 'whatsapp', to, type: 'document', document: { link: documentUrl, filename: filename.slice(0, 255) } };
}

function videoMessage(to, videoUrl, caption = '') {
  return { messaging_product: 'whatsapp', to, type: 'video', video: { link: videoUrl, caption } };
}

module.exports = {
  buttonMessage,
  listMessage,
  textMessage,
  imageMessage,
  documentMessage,
  videoMessage,
};