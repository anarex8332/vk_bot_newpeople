const { VK, Keyboard } = require('vk-io');
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

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, { step: 'start', data: {} });
  }
  return sessions.get(userId);
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

// Persistent keyboard — shown with EVERY message
let persistentKb;

function getKeyboard() {
  if (!persistentKb) {
    persistentKb = Keyboard.keyboard([
      Keyboard.textButton({
        label: 'Новая заявка',
        color: Keyboard.POSITIVE_COLOR,
        payload: { cmd: 'start' },
      }),
    ]);
  }
  return persistentKb;
}

async function send(peerId, msg, noKeyboard) {
  const params = {
    peer_id: peerId,
    message: msg,
    random_id: Math.floor(Math.random() * 1000000),
  };
  if (!noKeyboard) params.keyboard = getKeyboard(); // Pass KeyboardBuilder, NOT string
  try {
    await api.messages.send(params);
    console.log('[SEND] peer=' + peerId + ' msg=' + msg.substring(0, 40));
  } catch (err) {
    console.error('[SEND ERROR] peer=' + peerId + ' err=' + err.message + ' code=' + (err.code || '-'));
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

async function processMessage(userId, text, peerId, attachments) {
  const session = getSession(userId);

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
        const [user] = await api.users.get({ user_ids: userId });
        session.data.name = `${user.first_name} ${user.last_name}`;
      } catch (_) {}

      session.data.contact = `https://vk.com/id${userId}`;

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

    if (!response || !response.items) {
      console.log('[POLL] Нет данных в ответе');
      return;
    }

    console.log('[POLL] Получено диалогов: ' + response.items.length + ', lastMessageId=' + lastMessageId);

    for (const item of response.items) {
      const message = item.last_message || item;
      if (!message) { console.log('[POLL] Пропускаю: нет сообщения'); continue; }
      if (message.out === 1) { console.log('[POLL] Пропускаю: исходящее от бота, id=' + message.id); continue; }
      if (message.id <= lastMessageId) { console.log('[POLL] Пропускаю: старое, id=' + message.id + ' <= ' + lastMessageId); continue; }

      lastMessageId = Math.max(lastMessageId, message.id);
      console.log('[POLL] НОВОЕ СООБЩЕНИЕ id=' + message.id + ' from=' + message.from_id + ' text="' + (message.text || '').substring(0, 30) + '"');

      const peerId = message.peer_id;
      const userId = message.from_id;
      const text = (message.text || '').trim();
      const attachments = message.attachments || [];

      const sesh = sessions.get(userId);

      // If user has an active session — always process (error handlers inside will validate)
      if (sesh) {
        console.log('[POLL] Есть сессия, обрабатываю');
        await processMessage(userId, text, peerId, attachments);
        continue;
      }

      // No session — skip messages that look like noise
      const hasAnyAttach = attachments && attachments.length > 0;
      if (text.startsWith('[') || (!text && !hasAnyAttach)) {
        console.log('[POLL] Пропускаю: новый пользователь без текста');
        continue;
      }

      console.log('[POLL] Обрабатываю сообщение от user=' + userId + ' step=' + (sesh?.step || 'new'));
      await processMessage(userId, text, peerId, attachments);
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
