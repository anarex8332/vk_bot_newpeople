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

let lastMessageId = 0;

async function send(peerId, msg, keyboard) {
  const params = {
    peer_id: peerId,
    message: msg,
    random_id: Math.floor(Math.random() * 1000000),
  };
  if (keyboard) params.keyboard = keyboard;
  await api.messages.send(params);
}

function startKeyboard() {
  return JSON.stringify({
    one_time: false,
    buttons: [[{
      action: { type: 'text', label: 'Начать', payload: '{"cmd":"start"}' },
      color: 'positive',
    }]],
  });
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

  const greeting =
    'Привет! Я — цифровой помощник проекта "Городские решения" партии "Новые люди" в Кирове.\n\n' +
    'Помогу передать заявку на благоустройство города нашей команде.\n\n' +
    'Для начала — как к вам обращаться? (Имя или как вас представить)';

  if (text === '/start' || text === '/начать') {
    session.step = 'name';
    session.data = {};
    await send(peerId, greeting, startKeyboard());
    return;
  }

  switch (session.step) {
    case 'start':
      session.step = 'name';
      session.data = {};
      await send(peerId, greeting, startKeyboard());
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
      if (!isValidDescription(text)) {
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
          'Вместе мы сделаем Киров удобнее!',
          startKeyboard()
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
      await send(peerId, 'Напишите /start, чтобы начать новую заявку.', startKeyboard());
  }
}

async function pollMessages() {
  try {
    const response = await api.messages.getConversations({
      count: 20,
      v: '5.199',
    });

    if (!response || !response.items) return;

    for (const item of response.items) {
      const message = item.last_message || item;
      if (!message || message.out === 1) continue;
      if (message.id <= lastMessageId) continue;

      lastMessageId = Math.max(lastMessageId, message.id);

      const peerId = message.peer_id;
      const userId = message.from_id;
      const text = (message.text || '').trim();
      const attachments = message.attachments || [];

      // Allow empty text only if user has attachments and is on media step
      const session = sessions.get(userId);
      const hasPhoto = attachments.some(a => a.type === 'photo');
      if ((text.startsWith('[') || (!text && !hasPhoto)) && session?.step !== 'media') continue;

      await processMessage(userId, text, peerId, attachments);
    }
  } catch (err) {
    // Ignore polling errors
  }
}

console.log('✅ Бот "Городские решения" запущен!');
console.log('📱 Группа: https://vk.com/club' + GROUP_ID);

setInterval(pollMessages, 3000);

process.on('SIGINT', () => {
  console.log('\n👋 Бот остановлен');
  process.exit();
});
