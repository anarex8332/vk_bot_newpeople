const { VK } = require('vk-io');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.VK_TOKEN;
const GROUP_ID = 239506231;

if (!TOKEN) {
  console.error('Укажите VK_TOKEN');
  process.exit(1);
}

const vk = new VK({ token: TOKEN });
const api = vk.api;

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// ─── helpers ───────────────────────────────────────────────

function hasOnlyDigits(t) { return /^\d+$/.test(t.trim()); }
function hasDigits(t) { return /\d/.test(t); }
function hasLetters(t) { return /[а-яёa-z]/i.test(t); }
function isValidCity(t)  { return t.length >= 3 && !hasDigits(t) && hasLetters(t); }
function isValidAddress(t)  { return t.length >= 5 && !hasOnlyDigits(t) && hasLetters(t); }
function isValidDescription(t) { return t.length >= 5 && !hasOnlyDigits(t) && hasLetters(t); }
function isValidSupport(t)  { return t.length >= 2 && !hasOnlyDigits(t) && hasLetters(t); }

async function send(peerId, msg) {
  try {
    await api.messages.send({
      peer_id: peerId,
      message: msg,
      random_id: Math.floor(Math.random() * 1000000),
    });
  } catch (e) {
    console.error('[SEND ERR] peer=' + peerId + ' ' + e.message);
  }
}

function showConfirm(peer, peerId) {
  const pn = (peer.data.photos || []).length;
  send(peerId,
    'Проверьте, всё ли верно:\n\n' +
    'Город: ' + peer.data.city + '\n' +
    'Адрес: ' + peer.data.address + '\n' +
    'Проблема: ' + peer.data.problem + '\n' +
    'Идея: ' + peer.data.idea + '\n' +
    (pn ? 'Фото: ' + pn + ' шт.\n' : '') +
    'Поддержка: ' + peer.data.support + '\n\n' +
    'Напишите любой ответ для подтверждения заявки.\n' +
    'Чтобы исправить — напишите что именно ("город", "адрес", "проблема", "идея", "фото", "поддержка")');
}

function saveApplication(data) {
  const date = new Date().toISOString().split('T')[0];
  const file = path.join(DATA_DIR, `zayavki-${date}.json`);
  let apps = [];
  if (fs.existsSync(file)) apps = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const entry = {
    id: apps.length + 1,
    date: new Date().toISOString(),
    contact: data.contact,
    city: data.city,
    address: data.address,
    problem: data.problem,
    idea: data.idea,
    photos: data.photos || [],
    support: data.support,
  };
  apps.push(entry);
  fs.writeFileSync(file, JSON.stringify(apps, null, 2));
  return entry;
}

// ─── state ─────────────────────────────────────────────────

const peers = new Map();

function getPeer(peerId) {
  let p = peers.get(peerId);
  if (!p) {
    p = { step: 'start', data: { contact: '' }, lastMsgId: 0 };
    peers.set(peerId, p);
  }
  return p;
}

let ready = false;

async function loadConversations() {
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
    console.log('[OK] Диалогов загружено: ' + peers.size);
  } catch (e) {
    console.error('[ERR] loadConversations:', e.message);
  }
  ready = true;
  console.log('Бот запущен');
}

// ─── polling ───────────────────────────────────────────────

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

      // Fetch history for known conversations to catch inter-poll messages
      let messages = [{
        id: msg.id,
        from_id: msg.from_id,
        text: msg.text || '',
        attachments: msg.attachments || [],
      }];

      if (peer.lastMsgId > 0) {
        try {
          const hist = await api.messages.getHistory({ peer_id: msg.peer_id, count: 10, v: '5.199' });
          if (hist?.items?.length) {
            const unprocessed = hist.items.filter(m => !m.out && m.id > peer.lastMsgId).reverse();
            if (unprocessed.length > 0) messages = unprocessed;
          }
        } catch (_) {}
      }

      // Mark all as seen BEFORE processing
      for (const m of messages) {
        if (m.id > peer.lastMsgId) peer.lastMsgId = m.id;
      }

      for (const m of messages) {
        const text = (m.text || '').trim();
        const attachments = m.attachments || [];
        const hasAttach = attachments.length > 0;

        // Skip noise for brand-new conversations
        if (peer.step === 'start' && (text.startsWith('[') || (!text && !hasAttach))) continue;

        console.log('[MSG] peer=' + msg.peer_id + ' id=' + m.id + ' step=' + peer.step + ' t="' + text.substring(0, 40) + '"');
        await handleMessage(msg.peer_id, m.from_id, text, attachments);
      }
    }
  } catch (e) {
    console.error('[POLL ERR]', e.message);
  }
}

// ─── flow ──────────────────────────────────────────────────

function getGreeting() {
  return 'Привет! Я помощник проекта "Новые люди" в Кирове.\n\n' +
    'Помогу передать заявку на благоустройство города.\n\n' +
    'Напишите город или населённый пункт в Кировской области, где есть проблема.\n' +
    'Например: Киров, Кирово-Чепецк, Слободской';
}

async function handleMessage(peerId, userId, text, attachments) {
  const peer = getPeer(peerId);

  // /start, /stop, /начать, Начать → сброс
  if (text === '/start' || text === '/stop' || text === '/начать' || text.toLowerCase() === 'начать') {
    peer.step = 'city';
    peer.data = { contact: `https://vk.com/id${userId}` };
    await send(peerId, getGreeting());
    return;
  }

  // Стикер без текста → напомнить
  if (attachments && attachments.length && attachments.every(a => a.type === 'sticker') && !text) {
    const hints = {
      start: 'Напишите что-нибудь, чтобы начать.',
      city: 'Напишите город или населённый пункт.',
      address: 'Напишите адрес проблемы.',
      problem: 'Опишите, какая проблема.',
      idea: 'Напишите, что хотели бы видеть.',
      media: 'Пришлите фото проблемного места или напишите "нет", чтобы пропустить.',
      support: 'Напишите о поддержке соседей.',
      confirm: 'Напишите ответ для подтверждения.',
    };
    await send(peerId, 'Пожалуйста, напишите текстовое сообщение.\n\n' + (hints[peer.step] || ''));
    return;
  }

  switch (peer.step) {

    case 'start':
      peer.step = 'city';
      peer.data = { contact: `https://vk.com/id${userId}` };
      await send(peerId, getGreeting());
      break;

    case 'city': {
      if (!isValidCity(text)) {
        await send(peerId, 'Укажите название города буквами, без цифр.\nНапример: Киров, Кирово-Чепецк, Слободской');
        break;
      }
      peer.data.city = text;
      if (peer.editing) {
        peer.editing = false;
        peer.step = 'confirm';
        showConfirm(peer, peerId);
      } else {
        peer.step = 'address';
        await send(peerId,
          'Город записал.\n\n' +
          'Теперь напишите точный адрес: улицу и номер дома или название места.\n' +
          'Пример: ул. Ленина, д. 10, сквер у Драмтеатра');
      }
      break;
    }

    case 'address': {
      if (!isValidAddress(text)) {
        await send(peerId, 'Укажите конкретный адрес: улицу и номер дома или название места.\nПример: ул. Ленина, д. 10');
        break;
      }
      peer.data.address = text;
      if (peer.editing) {
        peer.editing = false;
        peer.step = 'confirm';
        showConfirm(peer, peerId);
      } else {
        peer.step = 'problem';
        await send(peerId,
          'Адрес записал.\n\n' +
          'В чем главная проблема?\n' +
          'Пример: разбитый асфальт, темнота во дворе, старая детская площадка');
      }
      break;
    }

    case 'problem': {
      if (!isValidDescription(text)) {
        await send(peerId, 'Опишите проблему подробнее — что именно вас беспокоит?\nПример: разбитый тротуар, нет фонарей, старая площадка');
        break;
      }
      peer.data.problem = text;
      if (peer.editing) {
        peer.editing = false;
        peer.step = 'confirm';
        showConfirm(peer, peerId);
      } else {
        peer.step = 'idea';
        await send(peerId,
          'Понял, записал.\n\n' +
          'Что именно вы хотите видеть на этом месте?\n' +
          'Например: новый тротуар, фонари, современная детская площадка, лавочки и зелень');
      }
      break;
    }

    case 'idea': {
      if (!isValidDescription(text)) {
        await send(peerId, 'Расскажите подробнее, что хотели бы видеть вместо текущей ситуации.\nНапример: новый тротуар, фонари, современная детская площадка');
        break;
      }
      peer.data.idea = text;
      if (peer.editing) {
        peer.editing = false;
        peer.step = 'confirm';
        showConfirm(peer, peerId);
      } else {
        peer.step = 'media';
        await send(peerId,
          'Отлично, идею записал!\n\n' +
          'Пришлите фото проблемного места, если есть.\n' +
          'Если нет фото — напишите "нет" или "пропустить"');
      }
      break;
    }

    case 'media': {
      const skip = ['нет', 'нeт', 'пропустить', 'skip', 'не', 'неа', 'no', 'фото нет', 'нет фото', 'пока нет', 'нечего'];
      const isSkip = skip.some(w => text.toLowerCase() === w);
      const hasPhoto = attachments && attachments.some(a => a.type === 'photo');

      if (!text && !hasPhoto && !isSkip) {
        await send(peerId, 'Пришлите фото или напишите "нет", чтобы пропустить.');
        break;
      }

      if (hasPhoto) {
        if (!peer.data.photos) peer.data.photos = [];
        for (const a of attachments) {
          if (a.type !== 'photo') continue;
          const photo = a.photo || a;
          peer.data.photos.push({
            type: a.type,
            owner_id: photo.owner_id,
            id: photo.id,
            access_key: photo.access_key || '',
          });
        }
        await send(peerId, 'Фото получено! (' + peer.data.photos.length + ' шт.)\nМожете прислать ещё фото или написать "нет", чтобы продолжить.');
        break;
      }

      if (isSkip) {
        if (peer.editing) {
          peer.editing = false;
          peer.step = 'confirm';
          showConfirm(peer, peerId);
        } else {
          peer.step = 'support';
          await send(peerId,
            'Хорошо.\n\n' +
            'Последний вопрос: готовы ли соседи поддержать изменения?\n' +
            'Может, уже собирали подписи или обсуждали с жильцами?');
        }
        break;
      }

      await send(peerId, 'Пришлите фото как изображение или напишите "нет".');
      break;
    }

    case 'support': {
      if (!isValidSupport(text)) {
        await send(peerId, 'Напишите пару слов — это важно для заявки.\nНапример: соседи поддерживают, собирали подписи');
        break;
      }
      peer.data.support = text;
      peer.step = 'confirm';

      try {
        const [u] = await api.users.get({ user_ids: userId });
        peer.data.contact = `https://vk.com/id${userId} (${u.first_name} ${u.last_name})`;
      } catch (_) {}

      showConfirm(peer, peerId);
      break;
    }

    case 'confirm': {
      // Check if user wants to edit a specific field
      const fieldMap = {
        'город': 'city', 'города': 'city', 'населённый': 'city', 'населенный': 'city',
        'адрес': 'address', 'адреса': 'address', 'место': 'address',
        'проблем': 'problem', 'проблему': 'problem',
        'иде': 'idea', 'идею': 'idea',
        'фот': 'media', 'фото': 'media',
        'поддержк': 'support', 'поддержка': 'support', 'сосед': 'support',
      };
      let targetStep = null;
      const lower = text.toLowerCase();
      for (const [keyword, step] of Object.entries(fieldMap)) {
        if (lower.includes(keyword)) { targetStep = step; break; }
      }

      if (targetStep) {
        peer.step = targetStep;
        peer.editing = true;
        const prompts = {
          city: 'Напишите правильный город или населённый пункт:',
          address: 'Напишите правильный адрес:',
          problem: 'Опишите проблему заново:',
          idea: 'Напишите вашу идею заново:',
          media: 'Пришлите новое фото или напишите "нет", чтобы пропустить:',
          support: 'Напишите о поддержке соседей заново:',
        };
        await send(peerId, prompts[targetStep] || 'Напишите правильный ответ:');
      } else {
        const entry = saveApplication(peer.data);
        peer.step = 'start';
        peer.data = { contact: '' };
        await send(peerId,
          'Заявка №' + entry.id + ' принята!\n\n' +
          'Она передана команде проекта. Мы свяжемся с вами, когда начнём проработку.\n\n' +
          'Вместе сделаем Киров удобнее!');
      }
      break;
    }

    default:
      peer.step = 'start';
      peer.data = { contact: '' };
      await send(peerId, 'Напишите "Начать", чтобы начать новую заявку.');
  }
}

// ─── start ─────────────────────────────────────────────────

loadConversations().then(() => setInterval(poll, 3000));

process.on('SIGINT', () => { console.log('Бот остановлен'); process.exit(); });
