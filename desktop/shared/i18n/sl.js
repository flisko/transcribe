// sl.js — slovenščina. Overlay on shared/copy.js: only translated keys appear
// here, anything missing keeps its English text.
//
// Notes for whoever edits this next:
//  - `ctx.setupName` is a FILE NAME ("Transcribe Setup" / "setup.command") and is
//    never translated — the user has to find it in Explorer/Finder.
//  - `ctx.plural(n, {one, two, few, other})` uses Intl's Slovenian rules, which
//    include the DUAL: 1 → one, 2 → two, 3-4 → few, 5+ and 0 → other. Missing the
//    dual is the giveaway of a machine translation; all four forms are required.
//  - Slovenian quotation marks are »takole«, not "takole".
//  - Durations use min/h, which do not inflect — deliberately kept out of the
//    plural system.
'use strict';

module.exports = function sl(ctx) {
  const { plural, setupName, isMac } = ctx;
  const thisComputer = isMac ? 'tem Macu' : 'tem računalniku';
  const yourComputer = isMac ? 'vaš Mac' : 'vaš računalnik';
  const fileManager = isMac ? 'Finderju' : 'Raziskovalcu';

  return {
    // Okno / vnos
    dropZoneTitle: 'Sem spustite zvočne ali videodatoteke',
    dropZoneSubtitle: 'MP3, MP4, MOV, M4A in večina drugih formatov',
    browse: 'Prebrskaj…',
    linkPrompt: 'Prilepite povezavo do videa — YouTube, TikTok, Instagram…',
    addLink: 'Dodaj',
    invalidLink: 'To ni videti kot povezava. Kopirajte naslov videa in ga prilepite sem.',
    searchLanguages: 'Iskanje jezikov',
    autoDetect: 'Samodejno zaznaj',
    modelDisplayBest: 'Najboljša kakovost',
    modelDisplayFast: 'Hitro',
    modelNotDownloadedSuffix: ' — ni preneseno',
    failModelMissing(display) {
      return `Model »${display}« ni prenesen. Zaženite ${setupName} (ponudi tudi dodatne modele) ali zamenjajte model.`;
    },
    fileGoneNote: 'Te datoteke ni več — morda je bila premaknjena ali izbrisana. Uporabite »Prepiši znova«, da jo obdelate na novo.',
    emptyTitle: 'Pripravljeno za prepis',
    emptySubtitle: 'Spustite datoteko zgoraj ali prilepite povezavo do videa.\nVsaka datoteka dobi prepis (.txt) in podnapise (.srt).',
    dropOverlay: 'Spustite za dodajanje v vrsto',
    dropOverlaySetup: 'Dokončajte namestitev, da začnete prepisovati',
    clearDone: 'Počisti končane',
    clearDoneTooltip: 'Odstrani končane elemente s seznama',
    settingsTooltip: 'Nastavitve',
    addFilesMenu: 'Dodaj datoteke…',
    addLinkMenu: 'Dodaj povezavo do videa…',
    cancelItemMenu: 'Prekliči element',

    // Stanje v vrsti
    waiting: 'Čaka…',
    lookingUp: 'Iščem video…',
    downloadingUnknown: 'Prenašam…',
    downloading(pct) { return `Prenašam — ${pct} %`; },
    preparing: 'Pripravljam zvok…',
    estimating: 'ocenjujem čas…',
    transcribing(pct, eta) { return `Prepisujem — ${pct} % · ${eta == null ? 'ocenjujem čas…' : eta}`; },
    continuingAfterSleep: 'Nadaljujem po mirovanju — osvežujem oceno časa…',
    canceled: 'Preklicano',
    transcriptCopied: 'Prepis je kopiran.',
    doneFile(duration) { return `Končano v ${duration} · prepis je shranjen ob izvirniku`; },
    doneLink(duration, folder) { return `Končano v ${duration} · shranjeno v ${folder}`; },

    // Dejanja v vrstici
    open: 'Odpri',
    openTranscript: 'Odpri prepis',
    openSubtitles: 'Odpri podnapise (.srt)',
    showInFinder: `Pokaži v ${fileManager}`,
    copyTranscript: 'Kopiraj besedilo prepisa',
    transcribeAgain: 'Prepiši znova',
    removeFromList: 'Odstrani s seznama',
    retry: 'Poskusi znova',
    startAgain: 'Zaženi znova',
    copyErrorDetails: 'Kopiraj podrobnosti napake',
    cancelTooltip: 'Prekliči',
    removeTooltip: 'Odstrani',

    // Napake
    failDownloadPrivateOrRemoved: 'Prenos ni uspel — video je morda zaseben ali odstranjen.',
    failDownloadNetwork: 'Prenos ni uspel — preverite internetno povezavo in pritisnite »Poskusi znova«.',
    failLookup: 'Na tej povezavi ni videa.',
    failNoVideoAtLink: 'Na tej povezavi ni videa — morda gre za objavo s fotografijo.',
    failNoAudio: 'Ta datoteka nima zvočnega zapisa.',
    failUnreadable: 'Te datoteke ni mogoče prebrati — morda je poškodovana ali pa ni zvočna oziroma videodatoteka.',
    failDisk: 'Na disku ni dovolj prostora. Sprostite nekaj prostora in pritisnite »Poskusi znova«.',
    failTranscription: 'Prepis ni bil dokončan. Pritisnite »Poskusi znova« — če še naprej ne uspe, poskusite model »Najboljša kakovost«.',
    failEngineMissing: `Manjka govorni pogon. Zaženite ${setupName} in pritisnite »Poskusi znova«.`,
    failAgeRestricted: 'Ta video ima starostno omejitev in ga stran prikazuje samo prijavljenim uporabnikom, zato ga Transcribe ne more prenesti.',
    failGeoBlocked: 'Ta video v vaši državi ni na voljo, zato ga ni mogoče prenesti.',
    failLoginRequired: 'Ta stran prikazuje ta video samo prijavljenim uporabnikom, zato ga ni mogoče prenesti neposredno (to je pogosto na Instagramu). Če si ga lahko ogledate v brskalniku, video shranite od tam in datoteko spustite v Transcribe.',
    failPlaylist(n) {
      const word = plural(n, {
        one: 'videoposnetek', two: 'videoposnetka', few: 'videoposnetki', other: 'videoposnetkov',
      });
      return `Ta povezava vodi do celotnega seznama predvajanja ali kanala (${n} ${word}), ne do enega videa. Odprite video, ki ga želite, kopirajte njegovo povezavo in prilepite tisto.`;
    },
    failLivestream: 'To je prenos v živo, Transcribe pa ne more snemati videa v živo. Ko se prenos konča in je posnetek na voljo na isti strani, povezavo prilepite znova in bo delovalo.',
    failStaleDownloader: `Prenos ni uspel — videostran je pri sebi najbrž nekaj spremenila. To je običajno in se preprosto reši: dvakrat kliknite ${setupName} (v mapi Transcribe), počakajte, da posodobi prenosnik, in pritisnite »Poskusi znova«.`,
    failDiskDownload: `Disk (${yourComputer}) je poln, zato se je prenos ustavil. Sprostite nekaj prostora in pritisnite »Poskusi znova«.`,
    failYtDlpMissing: `Za prenašanje videov z interneta je potreben majhen pomožni program, ki še ni nameščen. Enkrat dvakrat kliknite ${setupName} (v mapi Transcribe), da ga namestite. Datoteke, ki jih že imate na ${thisComputer}, lahko še naprej prepisujete.`,
    failFfmpegMissing: `Pomožni program, ki bere zvok iz videodatotek (ffmpeg), manjka na ${thisComputer}. Dvakrat kliknite ${setupName} (v mapi Transcribe), da ga namestite, in poskusite znova.`,
    failModelCorrupt: `Datoteka govornega modela na ${thisComputer} je videti poškodovana — običajno to pomeni, da je bil prenos nekje prekinjen. Dvakrat kliknite ${setupName}; prenesel bo svežo kopijo.`,
    failOutOfMemory(name) { return `Prepis datoteke »${name}« se je ustavil, ker je ${yourComputer} ostal brez pomnilnika. Zaprite nekaj drugih programov in poskusite znova — ali izberite model »Hitro«, ki potrebuje precej manj pomnilnika.`; },
    failFileMissing(name) { return `Preskočeno »${name}« — datoteke ni več mogoče najti. Morda je bila premaknjena, preimenovana ali izbrisana, ali pa je na disku, ki ni priklopljen.`; },
    failZeroLength(name) { return `Preskočeno »${name}« — datoteka je prazna, zato ni česa prepisati.`; },
    failFolderUnwritable(folder) { return `Transcribe ne more shranjevati prenosov v »${folder}« — mapa je bila morda izbrisana ali ni dovoljena. Izberite drugo mapo za prenose.`; },
    failOutputDirReadOnly(name) { return `Prepisi se shranjujejo ob videodatoteki, a mapa, v kateri je »${name}«, ne dovoljuje shranjevanja. Izberite drugo mapo za ta prepis ali pa video najprej kopirajte na ${yourComputer}.`; },
    failOutputLocked(name) { return `Datoteke »${name}« ni mogoče shraniti — nek program jo še vedno drži odprto. Zaprite ga (Word, Beležnica, predvajalnik…) in pritisnite »Poskusi znova«.`; },
    noSpeechNote(name) { return `Končano »${name}«, vendar govora ni bilo mogoče najti — prepis je prazen. Če ste pričakovali besede, preverite, ali se zvok v videu sliši in ali je izbran pravi jezik.`; },

    // Noga
    footerTranscribing(name, n, total, eta) {
      let s = `Prepisujem »${name}« — ${n} od ${total}`;
      if (eta != null) s += ` · ${eta}`;
      return s;
    },
    footerDownloading(title, n, total) { return `Prenašam »${title}« — ${n} od ${total}`; },
    footerFinished(done, failed) {
      if (failed === 0) {
        return plural(done, {
          one: 'Končano — prepis je pripravljen',
          two: `Končano — ${done} prepisa sta pripravljena`,
          few: `Končano — ${done} prepisi so pripravljeni`,
          other: `Končano — ${done} prepisov je pripravljenih`,
        });
      }
      return `Končano — ${done} uspešno, ${failed} neuspešno`;
    },
    cancelAll: 'Prekliči vse',

    // Namestitev
    setupTitle: 'Enkratna namestitev',
    setupIntro: `Transcribe potrebuje nekaj brezplačnih komponent, preden lahko začne. Vse teče na ${thisComputer} — nič se ne pošilja v splet.`,
    setupWhisper: 'Prepoznavanje govora (whisper)',
    setupFfmpeg: 'Pretvornik zvoka (ffmpeg)',
    setupModels: 'Jezikovni modeli (prenos 4,6 GB)',
    setupYtDlp: 'Prenosnik povezav (yt-dlp) — ni obvezen, potreben le za povezave do videa',
    installed: 'Nameščeno',
    notInstalled: 'Ni nameščeno',
    runSetup: 'Zaženi namestitev…',
    checkAgain: 'Preveri znova',
    setupFootnote: isMac
      ? 'Namestitev odpre Terminal in traja nekaj minut, večinoma zaradi prenosov. Lahko jo varno zaženete večkrat.'
      : 'Namestitev odpre okno PowerShell in traja nekaj minut, večinoma zaradi prenosov. Lahko jo varno zaženete večkrat.',
    engineMissing: isMac
      ? 'Transcribe ne najde svojega pogona. Transcribe.app naj ostane v mapi Transcribe, ob »bin« in »models«, nato kliknite »Preveri znova«.'
      : `Transcribe ne najde svojega pogona. Transcribe.exe naj ostane v mapi Transcribe, ob »${setupName}« in »models«, nato kliknite »Preveri znova«.`,
    linksLimitedPrompt: 'Za povezave do videa je potrebna še ena komponenta',
    linksLimitedInstall: 'Namesti…',
    linksLimitedCaption: 'Vse ostalo deluje — to vpliva samo na povezave do videa.',

    // Pogovorna okna in obvestila
    quitTitle: 'Zapreti Transcribe?',
    quitMessage: 'Delo še poteka. Če zdaj zaprete, se bo trenutni element ustavil — vse nedokončano bo preklicano.',
    quitKeepWorking: 'Nadaljuj z delom',
    quitAnyway: 'Vseeno zapri',
    notifOneTitle: 'Prepis je pripravljen',
    notifOneBody(txtName) { return `»${txtName}« je shranjen ob vašem videu.`; },
    notifAllTitle: 'Vsi prepisi so končani',
    notifAllBody(n) {
      return plural(n, {
        one: `${n} prepis je pripravljen.`,
        two: `${n} prepisa sta pripravljena.`,
        few: `${n} prepisi so pripravljeni.`,
        other: `${n} prepisov je pripravljenih.`,
      });
    },
    notifMixedTitle: 'Prepisi so končani',
    notifMixedBody(done, failed) { return `${done} uspešno, ${failed} neuspešno. Odprite Transcribe za podrobnosti.`; },
    notifFailedTitle: 'Prepis ni uspel',
    notifFailedBody(name) { return `»${name}« ni bilo mogoče prepisati. Odprite Transcribe za podrobnosti.`; },

    // Nastavitve
    settingsSectionTranscription: 'Prepisovanje',
    settingsModel: 'Model',
    settingsModelMissingTooltip: `Ta model ni prenesen — zaženite ${setupName}.`,
    settingsLanguage: 'Jezik',
    settingsLanguageHelp: 'Jezik, ki se govori v vaših datotekah. Izberite »Samodejno zaznaj«, če se spreminja ali niste prepričani.',
    settingsSectionLinks: 'Povezave do videa',
    settingsKeepVideo: 'Obdrži preneseno videodatoteko',
    settingsKeepVideoCaption: 'Ko je izklopljeno, se prenese samo zvok — hitreje in manj prostora. Prepis dobite v obeh primerih.',
    settingsDownloadFolder: 'Shrani prenose v',
    settingsChooseFolder: 'Izberi…',
    settingsSectionNotifications: 'Obvestila',
    settingsNotify: 'Obvesti me, ko se vrsta konča',

    // Posodobitve
    updateAvailable(version) { return `Na voljo je različica ${version}.`; },
    updateNow: 'Posodobi',
    updateDownloading(pct) { return `Prenašam posodobitev — ${pct} %`; },
    updateInstalling: 'Nameščam — Transcribe se bo čez trenutek znova zagnal…',
    updateInstallFailed: 'Posodobitve ni bilo mogoče namestiti. Odpiram stran za prenos, da posodobite ročno.',
    updateFolderReadOnly: 'Transcribe se iz te mape ne more posodobiti, ker ne dovoljuje sprememb. Mapo Transcribe premaknite nekam, kjer imate pravice (na primer Dokumenti), in poskusite znova.',
    checkForUpdatesMenu: 'Preveri za posodobitve…',
    settingsSectionUpdates: 'Posodobitve',
    settingsVersion(version) { return `Različica ${version}`; },
    settingsCheckNow: 'Preveri zdaj',
    settingsAutoCheck: 'Samodejno preverjaj za posodobitve',
    settingsAutoCheckCaption: 'Preveri enkrat ob vsakem zagonu Transcribea in prikaže pas, ko obstaja nova različica. Nič se ne zgodi, dokler ne pritisnete »Posodobi« — vaši modeli in nastavitve ostanejo nedotaknjeni.',
    updateChecking: 'Preverjam…',
    updateUpToDate: 'Imate najnovejšo različico.',
    updateCheckFailed: 'Trenutno ni mogoče preveriti posodobitev — preverite internetno povezavo in poskusite znova.',
    updateCheckUnavailable: 'Trenutno ni mogoče preveriti posodobitev — storitev za posodobitve ni dala odgovora. Vaša povezava je v redu; poskusite pozneje.',
    updateCheckOff: 'Ta kopija je bila zgrajena lokalno, zato nima izdaje, s katero bi se primerjala. Uradne izdaje preverjajo same.',

    // Zagon namestitve
    setupLaunchFailedTitle: `Ni mogoče odpreti ${setupName}`,
    setupLaunchFailedBody(scriptPath) {
      return isMac
        ? `Transcribe ni mogel samodejno zagnati namestitvene skripte.\n\nOdprite jo sami: dvakrat kliknite »setup.command« v mapi Transcribe. Če macOS to zavrne (»neznani razvijalec«), jo kliknite s tipko Control in izberite »Open«.\n\n${scriptPath}`
        : `Transcribe ni mogel samodejno zagnati namestitvene skripte.\n\nOdprite jo sami: dvakrat kliknite »${setupName}« v mapi Transcribe.\n\n${scriptPath}`;
    },
    setupLaunchFailedShow: `Pokaži v ${fileManager}`,
    setupLaunchFailedOK: 'V redu',
    setupNotFoundTitle: `Transcribe ne najde ${setupName}`,
    setupNotFoundBody(scriptPath) {
      return isMac
        ? `Transcribe je »setup.command« iskal ob sebi, a ga tam ni.\n\nTo običajno pomeni, da je bil Transcribe.app odprt neposredno iz datoteke zip ali sam zase. Celotno mapo »Transcribe« premaknite na primer v Applications ali Documents, nato pa v Terminalu enkrat zaženite to na tej mapi:\n\n    xattr -dr com.apple.quarantine /pot/do/Transcribe\n\nZatem znova odprite Transcribe.app iz te mape.\n\nIskano v: ${scriptPath}`
        : `Transcribe je »${setupName}« iskal ob sebi, a ga tam ni.\n\nTranscribe.exe naj ostane v mapi »Transcribe«, ki ste jo razpakirali, ob »${setupName}« in mapi »models«, nato poskusite znova.\n\nIskano v: ${scriptPath}`;
    },

    // Instagram
    connectInstagramMenu: 'Poveži Instagram…',
    disconnectInstagramMenu: 'Prekini povezavo z Instagramom',
    instagramConnectedTitle: 'Instagram je povezan',
    instagramConnectedBody: 'Povezave do Instagrama se bodo zdaj prenašale z vašo prijavo. Povezavo lahko kadar koli prekinete v meniju Datoteka.',
    instagramNotConnectedTitle: 'Ni povezano',
    instagramNotConnectedBody: 'V Instagram še niste prijavljeni, zato povezave do Instagrama morda še vedno ne bodo uspele. Znova izberite »Poveži Instagram…« in dokončajte prijavo.',
    instagramDisconnectedTitle: 'Povezava z Instagramom je prekinjena',
    instagramDisconnectedBody: 'Vaša prijava v Instagram je bila izbrisana iz te aplikacije.',

    // Trajanja in ocena časa
    durationPhrase(seconds) {
      if (seconds < 60) return 'manj kot minuto';
      const m = Math.max(1, Math.round(seconds / 60));
      if (m < 60) return `${m} min`;
      const h = Math.floor(m / 60);
      const r = m % 60;
      return r === 0 ? `${h} h` : `${h} h ${r} min`;
    },
    etaUnderMinute: 'še manj kot minuto',
    etaMinutes(m) { return `še približno ${m} min`; },
    etaHours(h) { return `še približno ${h} h`; },
    etaHoursMinutes(h, r) { return `še približno ${h} h ${r} min`; },
  };
};
