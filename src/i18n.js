// Все строки интерфейса Bot2 на трёх языках.
// Добавить новый язык = добавить блок с теми же ключами.

const translations = {
  ru: {
    // Приветствие
    welcome_name: 'Добро пожаловать в Marketing DNA 👋\n\nВы в правильном месте. Сейчас мы подготовим персональный контент-пакет специально для вашего бизнеса.\n\nЧто вы получите через 15–20 минут:\n✅ Готовый пост: текст + AI-изображение\n✅ Карусель — 5 оформленных слайдов\n✅ Сценарий Reels / TikTok\n✅ Обложка для видео\n✅ SEO-статья для сайта\n✅ Контент-план на 7 дней\n\nВсё бесплатно. Всё персонально — не шаблоны.\n\nДля этого нам нужно несколько коротких ответов о вашем бизнесе 👇\n\n📄 [Политика конфиденциальности](https://marketing-dna.com/privacy.html) · [Условия использования](https://marketing-dna.com/terms.html)',
    free_name_q: '*Как к вам обращаться?*\n\nНапишите ваше имя.',
    free_q1: '*Что вы продаёте и кому?*\n\nОпишите подробно: чем занимаетесь, кто ваши клиенты, что именно предлагаете.',
    free_q2: '*Где вы работаете и кому продаёте?*\n\nНапишите город, страну или регион — и продаёте ли вы локально, по всей стране или на международном рынке.\n\nПример: Рига, Латвия — продаём по всей Европе. Или: Москва — работаем только с местными клиентами.',
    free_done: '⏳ Отлично! Готовлю ваш пакет...\n\nЭто займёт 3-5 минут. Пришлю сюда как только будет готово.',
    ask_email_opt: '📩 Хотите получить копию на email?\n\nНапишите адрес — пришлём туда.\nИли напишите *нет* — пропустим этот шаг.',
    email_opt_saved: (email) => `✅ Отправим копию на ${email}`,
    email_opt_skip: '👍 Хорошо, пропускаем.',
    name_confirm: (name) => `Отлично, ${name}! Давайте начнём.\n\nЗадам вам 12 вопросов — займёт 5-7 минут. На основе ваших ответов подготовлю персональный бесплатный пакет контента.`,

    // Прогресс
    collecting_links: 'Отлично! Все ответы получены.\n\nПоследняя просьба — пришлите ссылки на ваши соцсети или сайт.\n\nInstagram, TikTok, LinkedIn, сайт — что есть. Это поможет понять как вы выглядите онлайн.\n\nКаждую ссылку отдельным сообщением.\nКогда добавите всё — напишите: готово\n\nЕсли ссылок пока нет — тоже напишите: готово',
    links_skip_warn: '⚠️ Без ссылок на соцсети я не смогу проанализировать ваш аккаунт.\n\nЕсли ссылок нет — напишите: готово',
    links_done: (count) => `✅ Принято ${count > 0 ? `(${count} ссылок)` : ''}. Перехожу к следующему шагу.`,
    generating_free: '⏳ Готовлю ваш бесплатный пакет...\n\nЭто займёт 3-5 минут — анализирую бизнес, аудиторию и конкурентов.',

    // Email
    ask_email: 'Куда прислать контент-план?\n\nНапишите ваш email — отправим туда готовые материалы.\n\nПолитика конфиденциальности: https://marketing-dna.com/privacy',
    email_saved: (email) => `✅ Email сохранён: ${email}`,

    // Язык
    ask_lang_docs: '*На каком языке подготовить аналитику и рабочие документы?*\n\nКонтент-план, анализ конкурентов, рекомендации — то что читаете вы.',
    ask_lang_content: '*На каком языке подготовить контент для публикации?*\n\nПосты, статьи, карусели, видео, обложки — то что увидят ваши клиенты.\n\n💡 В платных пакетах вы сможете добавить второй и третий язык — контент будет тот же, но на каждом из выбранных языков.',

    // Формат
    ask_format: 'Вопрос 12 из 12\n\nКак вы видите свой контент — какой формат вам ближе?',
    fmt_person: '🎬 С человеком в кадре',
    fmt_product: '📦 Без человека — продукт, процесс',
    fmt_unsure: '🤷 Не знаю — помогите выбрать',
    fmt_person_lead: '🎤 Главный герой — говорит и объясняет',
    fmt_person_support: '🤝 На втором плане — показывает процесс',

    // CTA
    ask_cta: 'Готовы ли вы отвечать на сообщения в директе?',
    cta_magnet: '✅ Готов + есть что предложить (гайд, скидка...)',
    cta_direct: '✅ Готов отвечать, но предложения пока нет',
    cta_no: '⛔ Директ не веду',
    ask_magnet: 'Отлично!\n\nЛид-магнит — это что-то ценное, что вы даёте человеку бесплатно в обмен на действие (написать вам, оставить контакт, подписаться).\n\nПростые примеры:\n— "бесплатная консультация 15 минут"\n— "PDF-гайд или чеклист по вашей теме"\n— "скидка 10% при упоминании кодового слова"\n— "мини-аудит / разбор вашей ситуации"\n\nЧто вы готовы предложить? Напишите в 1-2 предложениях.',

    // Скидка
    discount_offer: (pct, hours) => `🎁 Специально для вас — скидка ${pct}% на первый месяц.\n\nПредложение действует ${hours} часов.`,
    discount_expired: 'Скидка истекла. Доступны стандартные цены.',

    // Код доступа
    code_accepted: '✅ Код принят!\n\nВаш пакет уже готовится — пришлю сюда когда будет готово.\nОбычно занимает несколько часов.',
    code_not_found: 'Код не найден или уже использован. Проверьте правильность и попробуйте ещё раз.',

    // Платный онбординг
    paid_welcome: (pkg) => `Оплата получена — спасибо! Вы приобрели ${pkg}.\n\nЧтобы подготовить пакет максимально точно под ваш бизнес, задам вам 6 уточняющих вопросов. Это займёт 2-3 минуты.`,
    paid_done: '✅ Отлично! Все данные получены. Начинаю подготовку вашего пакета.\n\nОбычно это занимает 15-20 минут. Пришлю уведомление когда будет готово.',

    // Разное
    ready_continue: '📍 Продолжаем.',
    competitors_prompt: 'Вопрос 5 из 12\n\nНазовите 2-3 конкурентов — отправляйте по одному: название + ссылка на сайт или Telegram.\n\nПример:\nАгентство «Рост» — rost-agency.com\nСтудия Marketo — t.me/marketo_studio\n\nЕсли конкурент только в Instagram — напишите его название, я попрошу описание.\n\nКогда добавите всех — напишите: готово\nЕсли не знаете конкурентов — напишите: не знаю',
    competitors_done_btn: 'готово',
    competitors_unknown_btn: 'не знаю',
    competitors_searching: 'Понял — поищу конкурентов сам по нише и региону.',
    platform_instagram: '📸 Instagram',
    platform_tiktok: '🎵 TikTok',
    platform_facebook: '👤 Facebook',
    platform_linkedin: '💼 LinkedIn',
    platform_all: '🌐 Все платформы',
  },

  lv: {
    // Приветствие
    welcome_name: 'Laipni lūdzam Marketing DNA 👋\n\nJūs esat īstajā vietā. Tagad mēs sagatavosim personīgu satura pakotni tieši jūsu biznesam.\n\nKo jūs saņemsiet 15–20 minūtēs:\n✅ Gatavs ieraksts: teksts + AI attēls\n✅ Karuselis — 5 noformēti slaidi\n✅ Scenārijs Reels / TikTok\n✅ Video vāks\n✅ SEO raksts vietnei\n✅ Satura plāns 7 dienām\n\nViss bezmaksas. Viss personīgi — nevis veidnes.\n\nMums nepieciešamas tikai dažas īsas atbildes par jūsu biznesu 👇\n\n📄 [Privātuma politika](https://marketing-dna.com/privacy.html) · [Lietošanas noteikumi](https://marketing-dna.com/terms.html)',
    free_name_q: '*Kā ar jums sazināties?*\n\nUzrakstiet savu vārdu.',
    free_q1: '*Ko jūs pārdodat un kam?*\n\nAprakstiet sīkāk: ar ko nodarbojas, kas ir jūsu klienti un ko piedāvājat.',
    free_q2: '*Kur jūs strādājat un kam pārdodat?*\n\nNorādiet pilsētu, valsti vai reģionu — un vai pārdodat lokāli, visā valstī vai starptautiski.\n\nPiemērs: Rīga, Latvija — pārdodam visā Eiropā.',
    free_done: '⏳ Lieliski! Gatavoju jūsu paketi...\n\nTas aizņems 3-5 minūtes. Nosūtīšu šeit kad būs gatavs.',
    ask_email_opt: '📩 Vēlaties saņemt kopiju uz e-pastu?\n\nUzrakstiet adresi — nosūtīsim turp.\nVai rakstiet *nē* — izlaižam šo soli.',
    email_opt_saved: (email) => `✅ Nosūtīsim kopiju uz ${email}`,
    email_opt_skip: '👍 Labi, izlaižam.',
    name_confirm: (name) => `Lieliski, ${name}! Sāksim.\n\nUzdošu jums 12 jautājumus — tas aizņems 5-7 minūtes. Pamatojoties uz jūsu atbildēm, sagatavošu personalizētu bezmaksas satura paketi.`,

    // Прогресс
    collecting_links: 'Lieliski! Visas atbildes saņemtas.\n\nPēdējais lūgums — nosūtiet saites uz jūsu sociālajiem tīkliem vai vietni.\n\nInstagram, TikTok, LinkedIn, vietne — kas ir. Tas palīdzēs saprast, kā jūs izskatāties tiešsaistē.\n\nKatru saiti atsevišķā ziņojumā.\nKad viss pievienots — rakstiet: gatavs\n\nJa saišu pagaidām nav — arī rakstiet: gatavs',
    links_skip_warn: '⚠️ Bez saitēm uz sociālajiem tīkliem es nevarēšu analizēt jūsu kontu.\n\nJa saišu nav — rakstiet: gatavs',
    links_done: (count) => `✅ Pieņemts ${count > 0 ? `(${count} saites)` : ''}. Pāreju uz nākamo soli.`,
    generating_free: '⏳ Gatavoju jūsu bezmaksas paketi...\n\nTas aizņems 3-5 minūtes — analizēju biznesu, auditoriju un konkurentus.',

    // Email
    ask_email: 'Uz kurieni nosūtīt satura plānu?\n\nIerakstiet savu e-pastu — nosūtīsim materiālus uz turieni.\n\nKonfidencialitātes politika: https://marketing-dna.com/privacy',
    email_saved: (email) => `✅ E-pasts saglabāts: ${email}`,

    // Язык
    ask_lang_docs: '*Kādā valodā sagatavot analītiku un darba dokumentus?*\n\nSatura plāns, konkurentu analīze, ieteikumi — tas ko lasāt jūs.',
    ask_lang_content: '*Kādā valodā sagatavot saturu publicēšanai?*\n\nPublikācijas, raksti, karuseļi, video, vāki — tas ko redzēs jūsu klienti.\n\n💡 Maksas paketēs varēsiet pievienot otro un trešo valodu — saturs būs tāds pats, bet katrā izvēlētajā valodā.',

    // Формат
    ask_format: 'Jautājums 12 no 12\n\nKāds saturs jums vistuvāk — kāds formāts jums patīk?',
    fmt_person: '🎬 Ar cilvēku kadrā',
    fmt_product: '📦 Bez cilvēka — produkts, process',
    fmt_unsure: '🤷 Nezinu — palīdziet izvēlēties',
    fmt_person_lead: '🎤 Galvenais varonis — runā un skaidro',
    fmt_person_support: '🤝 Otrajā plānā — rāda procesu',

    // CTA
    ask_cta: 'Vai esat gatavs atbildēt uz ziņojumiem tiešajās ziņās?',
    cta_magnet: '✅ Gatavs + ir ko piedāvāt (ceļvedis, atlaide...)',
    cta_direct: '✅ Gatavs atbildēt, bet pagaidām nav piedāvājuma',
    cta_no: '⛔ Tiešās ziņas nevedu',
    ask_magnet: 'Lieliski!\n\nSvina magnēts ir kaut kas vērtīgs, ko dodat cilvēkam bez maksas apmaiņā pret darbību (rakstīt jums, atstāt kontaktu, abonēt).\n\nVienkārši piemēri:\n— "bezmaksas konsultācija 15 minūtes"\n— "PDF ceļvedis vai kontrolsaraksts par jūsu tēmu"\n— "10% atlaide, minot koda vārdu"\n— "mini audits / jūsu situācijas analīze"\n\nKo esat gatavs piedāvāt? Uzrakstiet 1-2 teikumos.',

    // Скидка
    discount_offer: (pct, hours) => `🎁 Speciāli jums — ${pct}% atlaide pirmajam mēnesim.\n\nPiedāvājums ir spēkā ${hours} stundas.`,
    discount_expired: 'Atlaide ir beigusies. Pieejamas standarta cenas.',

    // Код доступа
    code_accepted: '✅ Kods pieņemts!\n\nJūsu pakete jau tiek gatavota — nosūtīšu šeit kad būs gatava.\nParasti aizņem dažas stundas.',
    code_not_found: 'Kods nav atrasts vai jau izmantots. Pārbaudiet pareizību un mēģiniet vēlreiz.',

    // Платный онбординг
    paid_welcome: (pkg) => `Maksājums saņemts — paldies! Jūs iegādājāties ${pkg}.\n\nLai sagatavotu paketi maksimāli precīzi jūsu biznesam, uzdošu jums 6 precizējošus jautājumus. Tas aizņems 2-3 minūtes.`,
    paid_done: '✅ Lieliski! Visi dati saņemti. Sāku jūsu paketes sagatavošanu.\n\nParasti tas aizņem 15-20 minūtes. Nosūtīšu paziņojumu kad būs gatavs.',

    // Разное
    ready_continue: '📍 Turpinām.',
    competitors_prompt: 'Jautājums 5 no 12\n\nNosauciet 2-3 konkurentus — sūtiet pa vienam: nosaukums + saite uz vietni vai Telegram.\n\nPiemērs:\nAģentūra «Augsme» — augme.lv\nStudija Marketo — t.me/marketo_studio\n\nJa konkurents ir tikai Instagram — rakstiet nosaukumu, es palūgšu aprakstu.\n\nKad visi pievienoti — rakstiet: gatavs\nJa nezināt konkurentus — rakstiet: nezinu',
    competitors_done_btn: 'gatavs',
    competitors_unknown_btn: 'nezinu',
    competitors_searching: 'Sapratu — meklēšu konkurentus pats pēc nišas un reģiona.',
    platform_instagram: '📸 Instagram',
    platform_tiktok: '🎵 TikTok',
    platform_facebook: '👤 Facebook',
    platform_linkedin: '💼 LinkedIn',
    platform_all: '🌐 Visas platformas',
  },
};

// ─── ВОПРОСЫ 1–4 (LV) ─────────────────────────────────────────────────────────

const QUESTIONS_PART1_LV = [
  {
    key: 'region_language',
    text:
      'Jautājums 1 no 12\n\n' +
      'Kādā reģionā strādājat un kādā valodā veidojat saturu?\n' +
      'Vai nākotnē plānojat ienākt citā tirgū — vai būs nepieciešama cita valoda?\n\n' +
      'Piemērs: strādāju Rīgā, saturs latviešu valodā. Pēc gada plānoju ienākt Skandināvijas tirgū.',
    bridge: 'Sapratu — reģions un valoda fiksēti.',
  },
  {
    key: 'ideal_client',
    text:
      'Jautājums 2 no 12\n\n' +
      'Kas ir jūsu ideālais klients?\n' +
      'Aprakstiet: vecums, nodarbošanās, dzīvesveids, kas viņam ir svarīgi.\n\n' +
      'Piemērs: uzņēmēji 35–50 gadi, vada mazu uzņēmumu, vēlas attīstīties, bet nav laika mārketing.',
    bridge: 'Labi — auditorijas portrets pieņemts.',
  },
  {
    key: 'pain',
    text:
      'Jautājums 3 no 12\n\n' +
      'Kādu galveno problēmu vai sāpju punktu risina jūsu produkts?\n' +
      'Kas notiek ar klientu bez jums — un kas kļūst iespējams ar jūsu palīdzību?\n\n' +
      'Piemērs: kafejnīcu īpašnieki tērē stundas, meklējot piegādātājus — mēs automatizējam iepirkumus 15 minūtēs nedēļā.',
    bridge: 'Pieņēmu — tieši sāpju punkts padara saturu pievilcīgu.',
  },
  {
    key: 'utp',
    text:
      'Jautājums 4 no 12\n\n' +
      'Ar ko jūs atšķiraties no konkurentiem?\n\n' +
      'To sauc par USP — unikālo pārdošanas piedāvājumu: kas jums ir tāds, kā nav citiem?\n\n' +
      'Piemērs: mēs esam vienīgā juridiskā kompānija reģionā, kas specializējas tikai jaunuzņēmumos un strādā pēc fiksētas abonēšanas.',
    bridge: 'Lieliski. No unikalitātes veidojas spēcīgākie huki.',
  },
];

// ─── ВОПРОСЫ 6–11 (LV) ────────────────────────────────────────────────────────

const QUESTIONS_PART2_LV = [
  {
    key: 'customer_journey',
    text:
      'Jautājums 6 no 12\n\n' +
      'Kā klients nonāk līdz pirkumam?\n' +
      'No kurienes uzzina par jums, cik ilgi domā, kas palīdz pieņemt lēmumu?\n\n' +
      'Piemērs: klienti atrod caur ieteikumiem → skatās vietni → pierakstās bezmaksas auditam → pērk paketi.',
    bridge: 'Ņemšu vērā — klienta ceļš palīdz veidot saturu pārdošanas piltuves garumā.',
  },
  {
    key: 'objections',
    text:
      'Jautājums 7 no 12\n\n' +
      'Kādus iebildumus biežāk dzirdat no klientiem pirms pirkuma?\n' +
      'Kas viņus aptur — cena, šaubas, konkurenti?\n\n' +
      'Piemērs: «Dārgi», «Man jāpadomā», «Esmu mēģinājis ko līdzīgu — nedarbojās».',
    bridge: 'Labi — to ņemsim vērā, veidojot saturu.',
  },
  {
    key: 'content_history',
    text:
      'Jautājums 8 no 12\n\n' +
      'Ko jau esat mēģinājuši saturā — kādas platformas, formātus, tēmas?\n' +
      'Kas darbojās (vismaz mazliet), un kas neizdevās?\n\n' +
      'Piemērs: publicēju ekspertu rakstus Telegram — laba reakcija. YouTube mēģināju — neizdevās, grūti darīt regulāri.',
    bridge: 'Sapratu — jūsu pieredze ar saturu ņemta vērā.',
  },
  {
    key: 'content_goal',
    text:
      'Jautājums 9 no 12\n\n' +
      'Kādu galveno rezultātu vēlaties sasniegt ar saturu tuvāko 3 mēnešu laikā?\n\n' +
      'Piemērs: palielināt ienākošo pieprasījumu skaitu, izaugt no 300 līdz 1000 sekotājiem, kļūt par atzītu ekspertu savā nišā.',
    bridge: 'Pieņemts — uz šo mērķi balstīsim visu satura plāna struktūru.',
  },
  {
    key: 'price_range',
    text:
      'Jautājums 10 no 12\n\n' +
      'Norādiet savu galveno produktu vai pakalpojumu cenu diapazonu.\n\n' +
      'Piemērs: viena konsultācija — €80, ikmēneša pakete — €300–500, gada atbalsts — no €3000.',
    bridge: 'Labi — cenu diapazons fiksēts.',
  },
  {
    key: 'decision_maker',
    text:
      'Jautājums 11 no 12\n\n' +
      'Kas parasti pieņem lēmumu par pirkumu?\n' +
      'Klients izlemj pats vai saskaņo ar kādu — partneri, vadītāju, komandu?\n\n' +
      'Piemērs: privātie klienti izlemj paši. Korporatīvie — vienmēr saskaņo ar finanšu direktoru.',
    bridge: '',
  },
];

// ─── 12 вопросов платного онбординга на латышском ─────────────────────────────

const PAID_ONBOARDING_QUESTIONS_LV = [
  {
    key: 'ideal_client',
    text: 'Jautājums 1 no 12\n\nKas ir jūsu ideālais klients?\nAprakstiet: vecums, nodarbošanās, dzīvesveids, kas viņam ir svarīgi.\n\nPiemērs: sievietes 30–45, mazo uzņēmumu īpašnieces, vēlas izaugsmi, nav laika mārketingam.',
  },
  {
    key: 'pain_utp',
    text: 'Jautājums 2 no 12\n\nKādu galveno problēmu risina jūsu produkts — un ar ko jūs atšķiraties no konkurentiem?\n\nPiemērs: klienti tērē stundas satura meklēšanai — mēs visu darām viņu vietā. Atšķirība: tikai mazajiem uzņēmumiem, fiksēta cena.',
  },
  {
    key: 'competitors',
    text: 'Jautājums 3 no 12\n\nNosauciet 2-3 konkurentus — nosaukums un saite uz vietni vai Instagram.\n\nJa nezināt — rakstiet: nezinu, meklēsim paši.',
  },
  {
    key: 'customer_journey',
    text: 'Jautājums 4 no 12\n\nKā klients nonāk pie pirkuma?\nNo kurienes uzzina par jums, cik ilgi domā, kas palīdz pieņemt lēmumu?\n\nPiemērs: atrod caur ieteikumiem → skatās vietni → pierakstās auditam → pērk.',
  },
  {
    key: 'objections',
    text: 'Jautājums 5 no 12\n\nKādus iebildumus biežāk dzirdat pirms pirkuma?\n\nPiemērs: «Dārgi», «Man jāpadomā», «Esmu mēģinājis — nedarbojās».',
  },
  {
    key: 'content_history',
    text: 'Jautājums 6 no 12\n\nKo jau esat mēģinājuši saturā — platformas, formātus, tēmas?\nKas darbojās (vismaz mazliet), un kas neizdevās?\n\nPiemērs: Instagram — laba reakcija. YouTube — neizdevās.',
  },
  {
    key: 'price_range',
    text: 'Jautājums 7 no 12\n\nNorādiet savu pakalpojumu vai produktu cenu diapazonu.\n\nPiemērs: viena konsultācija €80, ikmēneša pakete €300–500.',
  },
  {
    key: 'decision_maker',
    text: 'Jautājums 8 no 12\n\nKas parasti pieņem lēmumu par pirkumu — klients pats vai saskaņo ar kādu?\n\nPiemērs: privātie — lemj paši. Korporatīvie — saskaņo ar direktoru.',
  },
  {
    key: 'content_goal_monthly',
    text: 'Jautājums 9 no 12\n\nKāds ir galvenais jūsu satura mērķis šajā mēnesī?\n\n(Nospiediet pogu)',
    buttons: [
      [{ text: '🎯 Piesaistīt jaunus klientus', callback_data: 'paid_cgoal_new' }],
      [{ text: '🔥 Pārdot tiem, kas jau zina par mani', callback_data: 'paid_cgoal_warm' }],
    ],
  },
  {
    key: 'monthly_focus',
    text: 'Jautājums 10 no 12\n\nKas plānots jūsu biznesā šajā mēnesī?\n\n(Izvēlieties vai uzrakstiet savu)',
    buttons: [
      [{ text: '🎉 Akcija vai atlaide', callback_data: 'paid_focus_promo' }],
      [{ text: '🚀 Jauna produkta/pakalpojuma palaišana', callback_data: 'paid_focus_launch' }],
      [{ text: '📅 Pasākums vai notikums', callback_data: 'paid_focus_event' }],
      [{ text: '📌 Parastais režīms, nekas īpašs', callback_data: 'paid_focus_normal' }],
    ],
  },
  {
    key: 'brand_voice',
    text: 'Jautājums 11 no 12\n\nKā izklausās jūsu zīmols — kāds ir tonis un stils?\n\nPiemērs: eksperta un nopietns / draudzīgs un vienkāršs / iedvesmojošs.',
  },
  {
    key: 'client_stories',
    text: 'Jautājums 12 no 12\n\nVai ir klientu stāsti, atsauksmes vai rezultāti saturam?\nPat viens piemērs ir ļoti vērtīgs.\n\nPiemērs: kliente Anna 3 mēnešos no nulles sasniedza €2000 mēnesī.',
  },
];

module.exports.QUESTIONS_PART1_LV = QUESTIONS_PART1_LV;
module.exports.QUESTIONS_PART2_LV = QUESTIONS_PART2_LV;
module.exports.PAID_ONBOARDING_QUESTIONS_LV = PAID_ONBOARDING_QUESTIONS_LV;

// Возвращает перевод строки
function T(key, lang = 'ru', ...args) {
  const dict = translations[lang] || translations.ru;
  const val = dict[key] ?? translations.ru[key];
  if (!val) return `[${key}]`;
  return typeof val === 'function' ? val(...args) : val;
}

// Определяет язык интерфейса из ?start= параметра
function langFromStartPayload(payload) {
  if (!payload) return 'ru';
  if (payload.startsWith('lv_')) return 'lv';
  if (payload.startsWith('en_')) return 'en';
  return 'ru';
}

module.exports = { T, langFromStartPayload, translations, QUESTIONS_PART1_LV, QUESTIONS_PART2_LV, PAID_ONBOARDING_QUESTIONS_LV };
