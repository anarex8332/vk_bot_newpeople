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

// Per-peer state: session (dialog step + data) + last processed message ID
const peers = new Map();

function getPeer(peerId) {
  let p = peers.get(peerId);
  if (!p) {
    p = { step: 'start', data: {}, lastMsgId: 0 };
    peers.set(peerId, p);
  }
  return p;
}

function saveApplication(data) {
  const date = new Date().toISOString().split('T')[0];
  const file = path.join(DATA_DIR, `zayavki-${date}.json`);
  let apps = [];
  if (fs.existsSync(file)) apps = JSON.parse(fs.readFileSync(file, 'utf-8'));
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

// ─── helpers ───────────────────────────────────────────────

function isValidName(t)  { return t.length >= 2 && /[а-яёa-z]/i.test(t); }
function isValidAddress(t) { return t.length >= 5; }
function isValidDesc(t)   { return t.length >= 5; }

async function send(peerId, msg) {
  const res = await fetch('https://api.vk.com/method/messages.send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      access_token: TOKEN,
      v: '5.199',
      peer_id: peerId,
      message: msg,
      random_id: Math.floor(Math.random() * 1000000),
    }).toString(),
  });
  const data = await res.json();
  if (data.error) {
    console.error('[SEND ERR] peer=' + peerId + ' code=' + data.error.error_code + ' ' + data.error.error_msg);
  } else {
    console.log('[SEND] peer=' + peerId + ' ' + msg.substring(0, 50));
  }
}

// ─── dialog flow ───────────────────────────────────────────

async function processMessage(peerId, userId, text, attachments) {
  const peer = getPeer(peerId);

  // /start → reset
  if (text === '/start' || text === '/начать') {
    peer.step = 'name';
    peer.data = {};
    await send(peerId,
      'Привет! Я — цифровой помощник проекта "Городские решения" партии "Новые люди" в Кирове.\n\n' +
      'Помогу передать заявку на благоустройство города нашей команде.\n\n' +
      'Для начала — как к вам обращаться? (Имя или как вас представить)');
    return;
  }

  // sticker-only → nudge
  if (attachments && attachments.length && attachments.every(a => a.type === 'sticker') && !text) {
    const hints = {
      start: 'Напишите что-нибудь, чтобы начать.',
      name: 'Напишите ваше имя.',
      address: 'Напишите адрес проблемы.',
      problem: 'Напишите, какая проблема.',
      idea: 'Напишите, что хотели бы видеть.',
      media: 'Пришлите фото или напишите "нет".',
      support: 'Напишите пару слов о поддержке.',
      done: 'Напишите "да", если всё верно.',
    };
    await send(peerId, 'Пожалуйста, напишите текстовое сообщение.\n\n' + (hints[peer.step] || ''));
    return;
  }

  switch (peer.step) {

    case 'start':
      peer.step = 'name';
      peer.data = {};
      await send(peerId,
        'Привет! Я — цифровой помощник проекта "Городские решения" партии "Новые люди" в Кирове.\n\n' +
        'Помогу передать заявку на благоустройство города нашей команде.\n\n' +
        'Для начала — как к вам обращаться? (Имя или как вас представить)');
      break;

    case 'name': {
      if (!isValidName(text)) {
        await send(peerId, 'Пожалуйста, напишите ваше имя буквами.\nНапример: Анна, Сергей, Елена');
        break;
      }
      peer.data.name = text;
      peer.step = 'address';
      await send(peerId,
        `Приятно познакомиться, ${text}!\n\n` +
        'Напишите конкретный адрес в Кирове или Кировской области, где есть проблема.\n' +
        'Пример: ул. Ленина, д. 10, сквер у Драмтеатра');
      break;
    }

    case 'address': {
      if (!isValidAddress(text)) {
        await send(peerId,
          'Пожалуйста, укажите более конкретный адрес.\n' +
          'Напишите улицу и номер дома (или название сквера/парка).\n' +
          'Пример: ул. Ленина, д. 10, сквер у Драмтеатра');
        break;
      }
      peer.data.address = text;
      peer.step = 'problem';
      await send(peerId,
        'Адрес записал.\n\n' +
        'Теперь опишите суть проблемы. Что именно не так?\n' +
        'Пример: разбитый тротуар, нет освещения, старая детская площадка, ямы на дороге');
      break;
    }

    case 'problem': {
      if (!isValidDesc(text)) {
        await send(peerId,
          'Опишите проблему подробнее — что именно вас беспокоит?\n' +
          'Например: разбитый тротуар возле дома, нет фонарей, старая детская площадка');
        break;
      }
      peer.data.problem = text;
      peer.step = 'idea';
      await send(peerId,
        'Понял, записал.\n\n' +
        'А теперь — ваша идея. Что именно вы хотите видеть на этом месте?\n' +
        'Например: новый тротуар, фонари, современная детская площадка, лавочки и зелень');
      break;
    }

    case 'idea': {
      if (!isValidDesc(text)) {
        await send(peerId,
          'Расскажите подробнее, что вы хотели бы видеть вместо текущей ситуации.\n' +
          'Например: новый тротуар, фонари, современная детская площадка');
        break;
      }
      peer.data.idea = text;
      peer.step = 'media';
      await send(peerId,
        'Отлично, идею записал!\n\n' +
        'Если есть фото проблемного места — пришлите их сейчас (можно несколько по одному).\n' +
        'Если нет фото — напишите "нет" или "пропустить", чтобы продолжить.');
      break;
    }

    case 'media': {
      const skipWords = ['нет', 'нeт', 'пропустить', 'skip', 'не', 'неа', 'no', 'фото нет', 'нет фото', 'пока нет', 'нечего'];
      const isSkip = skipWords.includes(text.toLowerCase());
      const hasPhoto = attachments && attachments.some(a => a.type === 'photo');
      const nonPhoto = attachments && attachments.some(a => a.type !== 'photo' && a.type !== 'sticker');

      if (!text && !hasPhoto && !isSkip) {
        await send(peerId, 'Пришлите фото как изображение или напишите "нет".');
        break;
      }
      if (nonPhoto && !hasPhoto) {
        await send(peerId, 'Я могу принять только фотографии. Пришлите фото или напишите "нет".');
        break;
      }
      if (hasPhoto) {
        if (!peer.data.photos) peer.data.photos = [];
        for (const a of attachments) {
          if (a.type !== 'photo') continue;
          peer.data.photos.push({
            type: a.type,
            owner_id: a[a.type]?.owner_id || a.owner_id,
            id: a[a.type]?.id || a.id,
            access_key: a[a.type]?.access_key || a.access_key,
          });
        }
        await send(peerId, '✅ Фото получено! (' + peer.data.photos.length + ' шт.)\n\nМожете прислать ещё фото или написать "нет", чтобы продолжить.');
        break;
      }
      if (isSkip) {
        peer.step = 'support';
        await send(peerId,
          'Понял.\n\n' +
          'Последний вопрос: готовы ли соседи или актив дома поддержать инициативу?\n' +
          'Может, уже собирали подписи или обсуждали с жильцами?');
        break;
      }
      await send(peerId, 'Я не совсем понял. Пришлите фото или напишите "нет", чтобы продолжить.');
      break;
    }

    case 'support': {
      if (!text || text.length < 2) {
        await send(peerId, 'Напишите пару слов о поддержке соседей — это важно для заявки.\nНапример: соседи поддерживают, собирали подписи, 10 человек за');
        break;
      }
      peer.data.support = text;
      peer.step = 'done';

      try {
        const [u] = await api.users.get({ user_ids: userId });
        peer.data.name = `${u.first_name} ${u.last_name}`;
      } catch (_) {}
      peer.data.contact = `https://vk.com/id${userId}`;

      const pn = (peer.data.photos || []).length;
      await send(peerId,
        'Спасибо! Всё записал. Проверьте, пожалуйста:\n\n' +
        'Адрес: ' + peer.data.address + '\n' +
        'Проблема: ' + peer.data.problem + '\n' +
        'Ваша идея: ' + peer.data.idea + '\n' +
        'Поддержка соседей: ' + peer.data.support +
        (pn ? '\nФото: ' + pn + ' шт.' : '') +
        '\n\nВсё верно? Напишите "да" для подтверждения.');
      break;
    }

    case 'done': {
      const confirm = ['да', 'всё верно', 'да всё верно', 'ок', 'окей', 'подтверждаю', 'yes', 'ага'].some(w => text.toLowerCase().includes(w));
      if (confirm) {
        const entry = saveApplication(peer.data);
        peer.step = 'start';
        peer.data = {};
        await send(peerId,
          '✅ Отлично! Ваша заявка №' + entry.id + ' принята!\n\n' +
          'Она передана нашей команде экспертов и куратору проекта в Кирове. ' +
          'Мы свяжемся с вами, когда начнём проработку эскиза.\n\n' +
          'Вместе мы сделаем Киров удобнее!');
      } else {
        await send(peerId, 'Если всё правильно — напишите "да".\nЕсли хотите что-то исправить — напишите, что именно не так.');
      }
      break;
    }

    default:
      peer.step = 'start';
      peer.data = {};
      await send(peerId, 'Напишите /start, чтобы начать новую заявку.');
  }
}

// ─── polling ───────────────────────────────────────────────

let ready = false;

async function initStartup() {
  try {
    const res = await api.messages.getConversations({ count: 200, v: '5.199' });
    if (res && res.items) {
      for (const item of res.items) {
        const m = item.last_message || item;
        if (m && m.id && m.peer_id) {
          getPeer(m.peer_id).lastMsgId = m.id;
        }
      }
    }
    console.log('[OK] VK API работает. Диалогов: ' + peers.size);
  } catch (e) {
    console.error('[ERR] VK API недоступен:', e.message);
  }
  ready = true;
  console.log('✅ Бот запущен. Группа: https://vk.com/club' + GROUP_ID);
}

async function poll() {
  if (!ready) return;
  try {
    const res = await api.messages.getConversations({ count: 20, v: '5.199' });
    if (!res || !res.items) return;

    for (const item of res.items) {
      const msg = item.last_message || item;
      if (!msg || msg.out === 1) continue;
      if (msg.id < 0) continue;

      const peer = getPeer(msg.peer_id);
      if (msg.id <= peer.lastMsgId) continue;

      // Known conversation → fetch history to catch messages sent between polls
      // New conversation (lastMsgId set by initStartup) → just process last message
      let messages = [{ id: msg.id, from_id: msg.from_id, text: msg.text || '', attachments: msg.attachments || [] }];

      if (peer.lastMsgId > 0) {
        try {
          const histRes = await api.messages.getHistory({
            peer_id: msg.peer_id,
            count: 10,
            v: '5.199',
          });
          if (histRes?.items?.length) {
            const unprocessed = histRes.items.filter(m => !m.out && m.id > peer.lastMsgId).reverse();
            if (unprocessed.length > 0) messages = unprocessed;
          }
        } catch (_) {}
      }

      // Mark all as seen BEFORE processing
      for (const m of messages) {
        if (m.id > peer.lastMsgId) peer.lastMsgId = m.id;
      }

      console.log('[POLL] peer=' + msg.peer_id + ' new=' + messages.length + ' msgs step=' + peer.step);

      for (const m of messages) {
        const text = (m.text || '').trim();
        const attachments = m.attachments || [];
        const hasAttach = attachments.length > 0;

        // Skip noise only for brand new peers
        if (peer.step === 'start' && (text.startsWith('[') || (!text && !hasAttach))) {
          console.log('[POLL] skipping noise');
          continue;
        }

        console.log('[MSG] id=' + m.id + ' text="' + text.substring(0, 40) + '" step=' + peer.step + '/' + peer.step);
        await processMessage(msg.peer_id, m.from_id, text, attachments);
      }
    }
  } catch (e) {
    console.error('[POLL ERR]', e.message);
  }
}

initStartup().then(() => setInterval(poll, 3000));

process.on('SIGINT', () => { console.log('\n👋 Бот остановлен'); process.exit(); });
