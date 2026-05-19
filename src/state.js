const { loadSession } = require('./persistence');

const sessions = new Map();

const STEPS = {
  ONBOARDING: 'onboarding',
  RETURNING_CHOICE: 'returning_choice',
  RETURNING_COMPETITORS: 'returning_competitors',
  RETURNING_QUESTIONS: 'returning_questions',
  COLLECTING_LINKS: 'collecting_links',
  BLOCK1_QUESTIONS: 'block1_questions',
  BLOCK1_ANSWERS: 'block1_answers',
  BLOCK2_QUESTIONS: 'block2_questions',
  BLOCK2_ANSWERS: 'block2_answers',
  BLOCK3_INPUT: 'block3_input',
  BLOCK3_COMPETITORS: 'block3_competitors',
  BLOCK4_CASTDEV: 'block4_castdev',
  BLOCK5_SEMANTICS: 'block5_semantics',
  BLOCK6_HEADLINES: 'block6_headlines',
  BLOCK7_ARTICLES: 'block7_articles',
  BLOCK8_SCRIPTS: 'block8_scripts',
  BLOCK9_CALENDAR: 'block9_calendar',
  BLOCK9_PLAN_A: 'block9_plan_a',
  BLOCK9_PLAN_B: 'block9_plan_b',
  DONE: 'done',
};

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    const saved = loadSession(chatId);
    sessions.set(chatId, saved || createSession());
  }
  return sessions.get(chatId);
}

function createSession() {
  return {
    step: STEPS.ONBOARDING,
    language: 'ru',
    region: null,
    regionLabel: null,
    links: [],
    scrapedContent: null,
    businessProfile: null,
    block1Questions: null,
    block1Answers: [],
    audience: null,
    block2Questions: null,
    block2Answers: [],
    competitorNames: [],
    competitors: null,
    castdev: null,
    castdevPhrases: null,
    semanticCore: null,
    headlines: null,
    headlinesUsedCount: 0,
    articles: null,
    videoScripts: null,
    carouselScripts: null,
    photoScripts: null,
    covers: null,
    calendar: null,
    questionIndex: 0,
    linksSkipWarned: false,
    autoSearchCompetitors: false,
    isReturningClient: false,
    bot2Data: null,
    returningAnswers: [],
    contentLanguage: null,
  };
}

function resetSession(chatId) {
  sessions.set(chatId, createSession());
}

module.exports = { getSession, resetSession, STEPS };
