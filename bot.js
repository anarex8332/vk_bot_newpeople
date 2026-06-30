const { VK } = require('vk-io');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.VK_TOKEN;
const GROUP_ID = 239506231;

if (!TOKEN) {
  console.error('❌ Укажите токен: VK_TOKEN=xxx node bot.js');
  process.exit(1);
}

const vk = new VK({ token: TOKEN });
const api = vk.api;

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000; // 30 минут

function getSession(userId) {
  const existing = sessions.get(userId);
  if (existing) {
    // Проверяем, не протухла ли сессия
    if (Date.now() - existing.ts > SESSION_TTL) {
      sessions.delete(userId);
    } else {
      existing.ts = Date.now(); // продлеваем
      return existing;
    }
  }
  const session = { step: 'start', data: {}, ts: Date.now() };
  sessions.set(userId, session);
  return session;
}

function saveApplication(data) {
  const date = new Date().toISOString().split('T')[0];
  const file = path.join(DATA_DIR, `zayavki-${date}.json`);

  let apps = [];
  if (fs.existsSync(file)) {
    apps = JSON.parse(fs.readFileSync(file, 'utf-8'));
  }

  const entry = {
    id: apps.length + 1,
    date: new Date().toISOString(),
    name: data.name || 'Не указано',
    contact: data.contact || 'Не указан',
    address: data.address,
    problem: data.problem,
    idea: data.idea,
    support: data.support,
    photos: data.photos || [],
  };

  apps.push(entry);
  fs.writeFileSync(file, JSON.stringify(apps, null, 2));
  return entry;
}

// Initialize with latest message to avoid re-processing old ones on restart
let lastMessageId = 0;
let initDone = false;
// Track last processed message ID per conversation (peer_id)
const conversationState = new Map();

async function initLastMessageId() {
  try {
    const response = await api.messages.getConversations({ count: 1, v: '5.199' });
    if (response && response.items && response.items[0]) {
      const msg = response.items[0].last_message || response.items[0];
      if (msg && msg.id) lastMessageId = msg.id;
    }
    console.log('[OK] VK API работает, токен валиден');
  } catch (err) {
    console.error('[ОШИБКА] VK API недоступен:', err.message);
    if (err.code === 5) console.error('[ОШИБКА] Токен недействителен! Проверьте VK_TOKEN в Railway');
    if (err.code === 15) console.error('[ОШИБКА] У токена нет прав на сообщения!');
    console.error('Бот будет работать, но может не отвечать на сообщения');
  }
  initDone = true;
  console.log('📬 Последнее обработанное сообщение ID:', lastMessageId);
}

async function send(peerId, msg) {
  const params = {
    access_token: TOKEN,
    v: '5.199',
    peer_id: peerId,
    message: msg,
    random_id: Math.floor(Math.random() * 1000000),
  };
  try {
    const res = await fetch('https://api.vk.com/method/messages.send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[SEND ERROR] peer=' + peerId + ' code=' + data.error.error_code + ' msg=' + data.error.error_msg);
    } else {
      console.log('[SEND] peer=' + peerId + ' ok msg=' + msg.substring(0, 40));
    }
  } catch (err) {
    console.error('[SEND ERROR] peer=' + peerId + ' err=' + err.message);
  }
}

function isValidName(text) {
  return text.length >= 2 && /[а-яёa-z]/i.test(text);
}

function isValidAddress(text) {
  return text.length >= 5;
}

function isValidDescription(text) {
  return text.length >= 5;
}

async function processMessage(sessionKey, vkUserId, text, peerId, attachments) {
  const session = getSession(sessionKey);

  // Sticker-only message: re-prompt the current question
  if (attachments && attachments.length > 0 && attachments.every(a => a.type === 'sticker') && !text) {
    const prompts = {
      'start': 'Напишите "Начать", чтобы оставить заявку.',
      'name': 'Напишите ваше имя, пожалуйста.',
      'address': 'Напишите адрес проблемы в Кирове.',
      'problem': 'Напишите, какая проблема вас беспокоит.',
      'idea': 'Напишите, что вы хотели бы видеть вместо этого.',
      'media': 'Пришлите фото проблемного места или напишите "нет", если фото нет.',
      'support': 'Напишите пару слов о поддержке соседей.',
      'done': 'Напишите "да", если всё верно в заявке.',
    };
    const tip = prompts[session.step] || 'Напишите текстовое сообщение, пожалуйста.';
    await send(peerId, '😊 Пожалуйста, напишите текстовое сообщение.\n\n' + tip);
    return;
  }

  const greeting =
    'Привет! Я — цифровой помощник проекта "Городские решения" партии "Новые люди" в Кирове.\n\n' +
    'Помогу передать заявку на благоустройство города нашей команде.\n\n' +
    'Для начала — как к вам обращаться? (Имя или как вас представить)';

  if (text === '/start' || text === '/начать') {
    session.step = 'name';
    session.data = {};
    await send(peerId, greeting);
    return;
  }

  switch (session.step) {
    case 'start':
      session.step = 'name';
      session.data = {};
      await send(peerId, greeting);
      break;

    case 'name': {
      if (!isValidName(text)) {
        await send(peerId,
          'Пожалуйста, напишите ваше имя буквами.\n' +
          'Например: Анна, Сергей, Елена'
        );
        break;
      }
      session.data.name = text;
      session.step = 'address';
      await send(peerId,
        `Приятно познакомиться, ${text}! \n\n` +
        'Напишите конкретный адрес в Кирове или Кировской области, где есть проблема.\n' +
        'Пример: ул. Ленина, д. 10, сквер у Драмтеатра'
      );
      break;
    }

    case 'address': {
      if (!isValidAddress(text)) {
        await send(peerId,
          'Пожалуйста, укажите более конкретный адрес.\n' +
          'Напишите улицу и номер дома (или название сквера/парка).\n' +
          'Пример: ул. Ленина, д. 10, сквер у Драмтеатра'
        );
        break;
      }
      session.data.address = text;
      session.step = 'problem';
      await send(peerId,
        'Адрес записал.\n\n' +
        'Теперь опишите суть проблемы. Что именно не так?\n' +
        'Пример: разбитый тротуар, нет освещения, старая детская площадка, ямы на дороге'
      );
      break;
    }

    case 'problem': {
      if (!isValidDescription(text)) {
        await send(peerId,
          'Опишите проблему подробнее — что именно вас беспокоит?\n' +
          'Например: разбитый тротуар возле дома, нет фонарей, старая детская площадка'
        );
        break;
      }
      session.data.problem = text;
      session.step = 'idea';
      await send(peerId,
        'Понял, записал.\n\n' +
        'А теперь — ваша идея. Что именно вы хотите видеть на этом месте?\n' +
        'Например: новый тротуар, фонари, современная детская площадка, лавочки и зелень'
      );
      break;
    }

    case 'idea': {
      if (!isValidDescription(text)) {
        await send(peerId,
          'Расскажите подробнее, что вы хотели бы видеть вместо текущей ситуации.\n' +
          'Например: новый тротуар, фонари, современная детская площадка'
        );
        break;
      }
      session.data.idea = text;
      session.step = 'media';
      await send(peerId,
        'Отлично, идею записал!\n\n' +
        'Если есть фото проблемного места — пришлите их сейчас (можно несколько по одному).\n' +
        'Если нет фото — напишите "нет" или "пропустить", чтобы продолжить.'
      );
      break;
    }

    case 'media': {
      const skipWords = ['нет', 'нeт', 'пропустить', 'skip', 'не', 'неа', 'no', 'фото нет', 'нет фото', 'пока нет', 'нечего'];
      const isSkip = skipWords.some(w => text.toLowerCase() === w.toLowerCase());
      const hasPhoto = attachments && attachments.some(a => a.type === 'photo');
      const hasOtherAttachment = attachments && attachments.some(a => a.type !== 'photo' && a.type !== 'sticker');

      // Empty text on media step: guide user (attachment may not come through getConversations)
      if (!text && !hasPhoto && !isSkip) {
        await send(peerId,
          'Пришлите фото проблемного места как изображение.\n' +
          'Если фото нет — напишите "нет" или "пропустить", и мы продолжим.'
        );
        break;
      }

      // If they sent a non-photo file
      if (hasOtherAttachment && !hasPhoto) {
        await send(peerId,
          'Я могу принять только фотографии. Документы, видео и другие файлы не поддерживаются.\n\n' +
          'Пришлите фото проблемного места или напишите "нет", чтобы продолжить.'
        );
        break;
      }

      // Photo received
      if (hasPhoto) {
        if (!session.data.photos) session.data.photos = [];
        for (const att of attachments) {
          if (att.type !== 'photo') continue;
          session.data.photos.push({
            type: att.type,
            owner_id: att[att.type]?.owner_id || att.owner_id,
            id: att[att.type]?.id || att.id,
            access_key: att[att.type]?.access_key || att.access_key,
          });
        }
        await send(peerId,
          '✅ Фото получено! (' + session.data.photos.length + ' шт.)\n\n' +
          'Можете прислать ещё фото или написать "нет", чтобы перейти к последнему вопросу.'
        );
        break;
      }

      // Skip — move to support
      if (isSkip) {
        session.step = 'support';
        const photoCount = session.data.photos ? session.data.photos.length : 0;
        const photoText = photoCount > 0 ? ' (' + photoCount + ' фото приложено)' : '';
        await send(peerId,
          'Понял' + photoText + '.\n\n' +
          'Последний вопрос: готовы ли соседи или актив дома поддержать инициативу?\n' +
          'Может, уже собирали подписи или обсуждали с жильцами?'
        );
        break;
      }

      // Random text instead of photo or skip
      await send(peerId,
        'Я не совсем понял. Если хотите приложить фото — отправьте его как изображение.\n' +
        'Если фото нет — напишите "нет" или "пропустить", и мы продолжим.'
      );
      break;
    }

    case 'support': {
      if (!text || text.length < 2) {
        await send(peerId,
          'Напишите пару слов о поддержке соседей — это важно для заявки.\n' +
          'Например: соседи поддерживают, собирали подписи, 10 человек за'
        );
        break;
      }
      session.data.support = text;
      session.step = 'done';

      try {
        const [user] = await api.users.get({ user_ids: vkUserId });
        session.data.name = `${user.first_name} ${user.last_name}`;
      } catch (_) {}

      session.data.contact = `https://vk.com/id${vkUserId}`;

      const photoCount = session.data.photos ? session.data.photos.length : 0;
      const photoLine = photoCount > 0 ? '\nФото: приложено ' + photoCount + ' шт.' : '';
      const summary =
        'Спасибо! Всё записал. Проверьте, пожалуйста, правильно ли я понял:\n\n' +
        'Адрес: ' + session.data.address + '\n' +
        'Проблема: ' + session.data.problem + '\n' +
        'Ваша идея: ' + session.data.idea + '\n' +
        'Поддержка соседей: ' + session.data.support +
        photoLine + '\n\n' +
        'Всё верно? Напишите "да" или "всё верно" для подтверждения.';

      await send(peerId, summary);
      break;
    }

    case 'done': {
      const confirmWords = ['да', 'всё верно', 'да всё верно', 'ок', 'окей', 'подтверждаю', 'yes', 'ага', 'так точно'];
      const isConfirm = confirmWords.some(w => text.toLowerCase().includes(w));

      if (isConfirm) {
        const entry = saveApplication(session.data);

        // Reset session so user can start a new application
        session.step = 'start';
        session.data = {};

        await send(peerId,
          '✅ Отлично! Ваша заявка №' + entry.id + ' принята!\n\n' +
          'Она передана нашей команде экспертов и куратору проекта в Кирове. ' +
          'Мы свяжемся с вами, когда начнём проработку эскиза.\n\n' +
          'Вместе мы сделаем Киров удобнее!'
        );
      } else {
        await send(peerId,
          'Если всё правильно — напишите "да".\n' +
          'Если хотите что-то исправить — напишите, что именно не так, и я помогу.'
        );
      }
      break;
    }

    default:
      session.step = 'start';
      session.data = {};
      await send(peerId, 'Напишите /start, чтобы начать новую заявку.');
  }
}

async function pollMessages() {
  if (!initDone) return;
  try {
    const response = await api.messages.getConversations({
      count: 20,
      v: '5.199',
    });

    if (!response || !response.items) return;

    for (const item of response.items) {
      const msg = item.last_message || item;
      if (!msg || msg.out === 1) continue;

      const peerId = msg.peer_id;
      const alreadySeen = conversationState.get(peerId) || 0;

      // Пропускаем если это сообщение или более старые уже обработаны
      if (msg.id <= alreadySeen) continue;

      // После рестарта — запоминаем где остановились, НО не обрабатываем старые сообщения
      if (alreadySeen === 0 && msg.id <= lastMessageId) {
        conversationState.set(peerId, msg.id);
        console.log('[POLL] Диалог peer=' + peerId + ' отмечен как обработанный (рестарт), последнее id=' + msg.id);
        continue;
      }

      // Получаем список сообщений для обработки
      // Для новой сессии — только последнее, для существующей — всю историю
      let histMessages;
      if (alreadySeen === 0) {
        histMessages = [{ id: msg.id, from_id: msg.from_id, text: msg.text || '', attachments: msg.attachments || [], out: msg.out }];
      } else {
        try {
          const histRes = await api.messages.getHistory({ peer_id: peerId, count: 10, v: '5.199' });
          histMessages = (histRes?.items || [])
            .filter(m => !m.out && m.id > alreadySeen)
            .reverse();
        } catch (_) {
          histMessages = [{ id: msg.id, from_id: msg.from_id, text: msg.text || '', attachments: msg.attachments || [], out: msg.out }];
        }
      }

      if (!histMessages.length) continue;

      console.log('[POLL] peer=' + peerId + ': ' + histMessages.length + ' сообщений (state=' + alreadySeen + ')');

      for (const m of histMessages) {
        if (m.id > lastMessageId) lastMessageId = m.id;
        if (m.id > (conversationState.get(peerId) || 0)) conversationState.set(peerId, m.id);

        const text = (m.text || '').trim();
        const attachments = m.attachments || [];
        const sesh = sessions.get(peerId);

        console.log('[POLL] from=' + m.from_id + ' text="' + text.substring(0, 40) + '" step=' + (sesh?.step || 'new'));

        if (sesh) {
          await processMessage(peerId, m.from_id, text, peerId, attachments);
        } else {
          const hasAnyAttach = attachments && attachments.length > 0;
          if (text.startsWith('[') || (!text && !hasAnyAttach)) continue;
          await processMessage(peerId, m.from_id, text, peerId, attachments);
        }
      }
    }
  } catch (err) {
    console.error('[POLL ERROR]', err.message, err.code ? 'code=' + err.code : '');
  }
}

initLastMessageId().then(() => {
  console.log('✅ Бот "Городские решения" запущен!');
  console.log('📱 Группа: https://vk.com/club' + GROUP_ID);
  setInterval(pollMessages, 3000);
});

process.on('SIGINT', () => {
  console.log('\n👋 Бот остановлен');
  process.exit();
});
