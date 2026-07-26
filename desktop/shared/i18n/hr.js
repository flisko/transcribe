// hr.js — hrvatski. Overlay on shared/copy.js: only translated keys appear here,
// anything missing keeps its English text (so a half-finished translation is
// never a broken UI).
//
// Notes for whoever edits this next:
//  - `ctx.setupName` is a FILE NAME ("Transcribe Setup" / "setup.command") and is
//    never translated — the user has to find it in Explorer/Finder.
//  - `ctx.plural(n, {one, few, other})` uses Intl's Croatian rules:
//    1 → one, 2-4 → few, 5+ and 0 → other. Do not hand-roll this.
//  - Croatian quotation marks are „ovako”, not "ovako".
//  - Durations use min/h, which do not inflect — deliberately kept out of the
//    plural system.
'use strict';

module.exports = function hr(ctx) {
  const { plural, setupName, isMac } = ctx;
  const thisComputer = isMac ? 'ovom Macu' : 'ovom računalu';
  const yourComputer = isMac ? 'vaš Mac' : 'vaše računalo';
  const yourComputerDat = isMac ? 'vaš Mac' : 'vaše računalo';
  const fileManager = isMac ? 'Finderu' : 'Exploreru';

  return {
    // Prozor / unos
    dropZoneTitle: 'Ovdje ispustite audio ili video datoteke',
    dropZoneSubtitle: 'MP3, MP4, MOV, M4A i većina drugih formata',
    browse: 'Odaberi…',
    linkPrompt: 'Zalijepite poveznicu na video — YouTube, TikTok, Instagram…',
    addLink: 'Dodaj',
    invalidLink: 'Ovo ne izgleda kao poveznica. Kopirajte adresu videa i zalijepite je ovdje.',
    searchLanguages: 'Pretraži jezike',
    autoDetect: 'Automatski prepoznaj',
    modelDisplayBest: 'Najbolja kvaliteta',
    modelDisplayFast: 'Brzo',
    modelNotDownloadedSuffix: ' — nije preuzeto',
    failModelMissing(display) {
      return `Model „${display}” nije preuzet. Pokrenite ${setupName} (nudi i dodatne modele) ili promijenite model.`;
    },
    fileGoneNote: 'Te datoteke više nema — možda je premještena ili izbrisana. Upotrijebite „Prepiši ponovno” da je obradite iznova.',
    emptyTitle: 'Spremno za prepisivanje',
    emptySubtitle: 'Ispustite datoteku iznad ili zalijepite poveznicu na video.\nSvaka datoteka dobiva prijepis (.txt) i titlove (.srt).',
    dropOverlay: 'Ispustite za dodavanje u red',
    dropOverlaySetup: 'Dovršite postavljanje da biste mogli prepisivati',
    clearDone: 'Očisti gotove',
    clearDoneTooltip: 'Ukloni završene stavke s popisa',
    settingsTooltip: 'Postavke',
    addFilesMenu: 'Dodaj datoteke…',
    addLinkMenu: 'Dodaj poveznicu na video…',
    cancelItemMenu: 'Prekini stavku',

    // Status u redu čekanja
    waiting: 'Čeka…',
    lookingUp: 'Tražim video…',
    downloadingUnknown: 'Preuzimam…',
    downloading(pct) { return `Preuzimam — ${pct} %`; },
    preparing: 'Pripremam zvuk…',
    estimating: 'procjenjujem vrijeme…',
    transcribing(pct, eta) { return `Prepisujem — ${pct} % · ${eta == null ? 'procjenjujem vrijeme…' : eta}`; },
    continuingAfterSleep: 'Nastavljam nakon mirovanja — osvježavam procjenu vremena…',
    canceled: 'Prekinuto',
    transcriptCopied: 'Prijepis je kopiran.',
    doneFile(duration) { return `Gotovo za ${duration} · prijepis je spremljen uz izvornik`; },
    doneLink(duration, folder) { return `Gotovo za ${duration} · spremljeno u ${folder}`; },

    // Radnje na retku
    open: 'Otvori',
    openTranscript: 'Otvori prijepis',
    openSubtitles: 'Otvori titlove (.srt)',
    showInFinder: `Prikaži u ${fileManager}`,
    copyTranscript: 'Kopiraj tekst prijepisa',
    transcribeAgain: 'Prepiši ponovno',
    removeFromList: 'Ukloni s popisa',
    retry: 'Pokušaj ponovno',
    startAgain: 'Pokreni ponovno',
    copyErrorDetails: 'Kopiraj pojedinosti o pogrešci',
    cancelTooltip: 'Prekini',
    removeTooltip: 'Ukloni',

    // Pogreške
    failDownloadPrivateOrRemoved: 'Preuzimanje nije uspjelo — video je možda privatan ili uklonjen.',
    failDownloadNetwork: 'Preuzimanje nije uspjelo — provjerite internetsku vezu pa pritisnite „Pokušaj ponovno”.',
    failLookup: 'Na ovoj poveznici nema videa.',
    failNoVideoAtLink: 'Na ovoj poveznici nema videa — možda je riječ o objavi s fotografijom.',
    failNoAudio: 'Ova datoteka nema zvučni zapis.',
    failUnreadable: 'Ovu datoteku nije moguće pročitati — možda je oštećena ili nije audio/video datoteka.',
    failDisk: 'Nema dovoljno prostora na disku. Oslobodite nešto prostora pa pritisnite „Pokušaj ponovno”.',
    failTranscription: 'Prepisivanje nije dovršeno. Pritisnite „Pokušaj ponovno” — ako i dalje ne uspijeva, isprobajte model „Najbolja kvaliteta”.',
    failEngineMissing: `Nedostaje govorni pogon. Pokrenite ${setupName} pa pritisnite „Pokušaj ponovno”.`,
    failAgeRestricted: 'Ovaj je video dobno ograničen i stranica ga prikazuje samo prijavljenim korisnicima, pa ga Transcribe ne može preuzeti.',
    failGeoBlocked: 'Ovaj video nije dostupan u vašoj zemlji, pa se ne može preuzeti.',
    failLoginRequired: 'Ova stranica prikazuje taj video samo prijavljenim korisnicima, pa se ne može izravno preuzeti (to je uobičajeno na Instagramu). Ako ga možete gledati u pregledniku, spremite video odande i ispustite datoteku u Transcribe.',
    failPlaylist(n) {
      const word = plural(n, { one: 'videozapis', few: 'videozapisa', other: 'videozapisa' });
      return `Ova poveznica vodi na cijelu playlistu ili kanal (${n} ${word}), a ne na jedan video. Otvorite video koji želite, kopirajte njegovu poveznicu i zalijepite nju.`;
    },
    failLivestream: 'Ovo je prijenos uživo, a Transcribe ne može snimati video uživo. Kad prijenos završi i snimka bude dostupna na istoj stranici, zalijepite poveznicu ponovno i radit će.',
    failStaleDownloader: `Preuzimanje nije uspjelo — stranica s videom vjerojatno je nešto promijenila kod sebe. To je normalno i lako se rješava: dvaput kliknite ${setupName} (u mapi Transcribe), pustite da ažurira preuzimatelj pa pritisnite „Pokušaj ponovno”.`,
    failDiskDownload: `Disk (${yourComputer}) je pun pa se preuzimanje zaustavilo. Oslobodite nešto prostora pa pritisnite „Pokušaj ponovno”.`,
    failYtDlpMissing: `Za preuzimanje videa s interneta potreban je mali pomoćni program koji još nije instaliran. Dvaput kliknite ${setupName} (u mapi Transcribe) jednom da ga instalirate. I dalje možete prepisivati datoteke koje već imate na ${thisComputer}.`,
    failFfmpegMissing: `Pomoćni program koji čita zvuk iz videodatoteka (ffmpeg) nedostaje na ${thisComputer}. Dvaput kliknite ${setupName} (u mapi Transcribe) da ga instalirate pa pokušajte ponovno.`,
    failModelCorrupt: `Datoteka govornog modela na ${thisComputer} djeluje oštećeno — obično to znači da je preuzimanje negdje prekinuto. Dvaput kliknite ${setupName}; preuzet će novu kopiju.`,
    failOutOfMemory(name) { return `Prepisivanje datoteke „${name}” zaustavljeno je jer je ${yourComputer} ostalo bez memorije. Zatvorite neke druge programe i pokušajte ponovno — ili odaberite model „Brzo”, koji treba znatno manje memorije.`; },
    failFileMissing(name) { return `Preskočeno „${name}” — datoteku više nije moguće pronaći. Možda je premještena, preimenovana ili izbrisana, ili je na disku koji nije priključen.`; },
    failZeroLength(name) { return `Preskočeno „${name}” — datoteka je prazna pa nema što prepisati.`; },
    failFolderUnwritable(folder) { return `Transcribe ne može spremati preuzimanja u „${folder}” — mapa je možda izbrisana ili nije dopuštena. Odaberite drugu mapu za preuzimanja.`; },
    failOutputDirReadOnly(name) { return `Prijepisi se spremaju uz videodatoteku, ali mapa u kojoj je „${name}” ne dopušta spremanje. Odaberite drugu mapu za ovaj prijepis ili prvo kopirajte video na ${yourComputerDat}.`; },
    failOutputLocked(name) { return `Nije moguće spremiti „${name}” — datoteku još drži otvorenom neki program. Zatvorite ga (Word, Notepad, media player…) pa pritisnite „Pokušaj ponovno”.`; },
    noSpeechNote(name) { return `Dovršeno „${name}”, ali govor nije pronađen — prijepis je prazan. Ako ste očekivali riječi, provjerite čuje li se zvuk u videu i je li odabran ispravan jezik.`; },

    // Podnožje
    footerTranscribing(name, n, total, eta) {
      let s = `Prepisujem „${name}” — ${n} od ${total}`;
      if (eta != null) s += ` · ${eta}`;
      return s;
    },
    footerDownloading(title, n, total) { return `Preuzimam „${title}” — ${n} od ${total}`; },
    footerFinished(done, failed) {
      if (failed === 0) {
        return plural(done, {
          one: 'Gotovo — prijepis je spreman',
          few: `Gotovo — ${done} prijepisa su spremna`,
          other: `Gotovo — ${done} prijepisa je spremno`,
        });
      }
      return `Završeno — ${done} uspješno, ${failed} neuspješno`;
    },
    cancelAll: 'Prekini sve',

    // Postavljanje
    setupTitle: 'Jednokratno postavljanje',
    setupIntro: `Transcribeu treba nekoliko besplatnih komponenti prije nego što može krenuti. Sve radi na ${thisComputer} — ništa se ne šalje na internet.`,
    setupWhisper: 'Prepoznavanje govora (whisper)',
    setupFfmpeg: 'Pretvarač zvuka (ffmpeg)',
    setupModels: 'Jezični modeli (preuzimanje 4,6 GB)',
    setupYtDlp: 'Preuzimatelj poveznica (yt-dlp) — nije obavezan, treba samo za poveznice na video',
    installed: 'Instalirano',
    notInstalled: 'Nije instalirano',
    runSetup: 'Pokreni postavljanje…',
    checkAgain: 'Provjeri ponovno',
    setupFootnote: isMac
      ? 'Postavljanje otvara Terminal i traje nekoliko minuta, uglavnom zbog preuzimanja. Može se sigurno pokrenuti više puta.'
      : 'Postavljanje otvara PowerShell prozor i traje nekoliko minuta, uglavnom zbog preuzimanja. Može se sigurno pokrenuti više puta.',
    engineMissing: isMac
      ? 'Transcribe ne može pronaći svoj pogon. Držite Transcribe.app u mapi Transcribe, uz „bin” i „models”, pa kliknite „Provjeri ponovno”.'
      : `Transcribe ne može pronaći svoj pogon. Držite Transcribe.exe u mapi Transcribe, uz „${setupName}” i „models”, pa kliknite „Provjeri ponovno”.`,
    linksLimitedPrompt: 'Za poveznice na video treba još jedna komponenta',
    linksLimitedInstall: 'Instaliraj…',
    linksLimitedCaption: 'Sve ostalo radi — ovo se odnosi samo na poveznice na video.',

    // Dijalozi i obavijesti
    quitTitle: 'Zatvoriti Transcribe?',
    quitMessage: 'Posao je još u tijeku. Zatvaranje sada zaustavit će trenutnu stavku — sve nedovršeno bit će prekinuto.',
    quitKeepWorking: 'Nastavi rad',
    quitAnyway: 'Ipak zatvori',
    notifOneTitle: 'Prijepis je spreman',
    notifOneBody(txtName) { return `„${txtName}” je spremljen uz vaš video.`; },
    notifAllTitle: 'Sva prepisivanja su gotova',
    notifAllBody(n) {
      return plural(n, {
        one: `${n} prijepis je spreman.`,
        few: `${n} prijepisa su spremna.`,
        other: `${n} prijepisa je spremno.`,
      });
    },
    notifMixedTitle: 'Prepisivanja su gotova',
    notifMixedBody(done, failed) { return `${done} uspješno, ${failed} neuspješno. Otvorite Transcribe za pojedinosti.`; },
    notifFailedTitle: 'Prepisivanje nije uspjelo',
    notifFailedBody(name) { return `„${name}” nije bilo moguće prepisati. Otvorite Transcribe za pojedinosti.`; },

    // Postavke
    settingsSectionTranscription: 'Prepisivanje',
    settingsModel: 'Model',
    settingsModelMissingTooltip: `Ovaj model nije preuzet — pokrenite ${setupName}.`,
    settingsLanguage: 'Jezik',
    settingsLanguageHelp: 'Jezik koji se govori u vašim datotekama. Odaberite „Automatski prepoznaj” ako se mijenja ili niste sigurni.',
    settingsSectionLinks: 'Poveznice na video',
    settingsKeepVideo: 'Zadrži preuzetu videodatoteku',
    settingsKeepVideoCaption: 'Kad je isključeno, preuzima se samo zvuk — brže je i zauzima manje. Prijepis dobivate u oba slučaja.',
    settingsDownloadFolder: 'Spremi preuzimanja u',
    settingsChooseFolder: 'Odaberi…',
    settingsSectionNotifications: 'Obavijesti',
    settingsNotify: 'Obavijesti me kad red čekanja završi',

    // Ažuriranja
    updateAvailable(version) { return `Dostupna je verzija ${version}.`; },
    updateDownload: 'Preuzmi',
    checkForUpdatesMenu: 'Provjeri ima li ažuriranja…',
    settingsSectionUpdates: 'Ažuriranja',
    settingsVersion(version) { return `Verzija ${version}`; },
    settingsCheckNow: 'Provjeri sada',
    settingsAutoCheck: 'Automatski provjeravaj ima li ažuriranja',
    settingsAutoCheckCaption: 'Provjerava jednom pri svakom pokretanju Transcribea i prikazuje traku kad postoji nova verzija. Ništa se ne preuzima ni ne instalira samo od sebe — vi odlučujete kada ćete ažurirati.',
    updateChecking: 'Provjeravam…',
    updateUpToDate: 'Imate najnoviju verziju.',
    updateCheckFailed: 'Trenutačno nije moguće provjeriti ima li ažuriranja — provjerite internetsku vezu i pokušajte ponovno.',
    updateCheckUnavailable: 'Trenutačno nije moguće provjeriti ima li ažuriranja — servis za ažuriranja nije dao odgovor. Vaša veza je u redu; pokušajte kasnije.',
    updateCheckOff: 'Ova je kopija izgrađena lokalno pa nema izdanje s kojim bi se usporedila. Službena izdanja provjeravaju sama.',

    // Pokretanje postavljanja
    setupLaunchFailedTitle: `Nije moguće otvoriti ${setupName}`,
    setupLaunchFailedBody(scriptPath) {
      return isMac
        ? `Transcribe nije mogao automatski pokrenuti skriptu za postavljanje.\n\nOtvorite je sami: dvaput kliknite „setup.command” u mapi Transcribe. Ako macOS odbije („nepoznati razvijatelj”), kliknite je uz Control i odaberite „Open”.\n\n${scriptPath}`
        : `Transcribe nije mogao automatski pokrenuti skriptu za postavljanje.\n\nOtvorite je sami: dvaput kliknite „${setupName}” u mapi Transcribe.\n\n${scriptPath}`;
    },
    setupLaunchFailedShow: `Prikaži u ${fileManager}`,
    setupLaunchFailedOK: 'U redu',
    setupNotFoundTitle: `Transcribe ne može pronaći ${setupName}`,
    setupNotFoundBody(scriptPath) {
      return isMac
        ? `Transcribe je tražio „setup.command” uz sebe, ali ga ondje nema.\n\nTo obično znači da je Transcribe.app otvoren izravno iz zip datoteke ili sam za sebe. Premjestite cijelu mapu „Transcribe” npr. u Applications ili Documents, a zatim u Terminalu jednom pokrenite ovo na toj mapi:\n\n    xattr -dr com.apple.quarantine /putanja/do/Transcribe\n\nPa ponovno otvorite Transcribe.app iz te mape.\n\nTraženo u: ${scriptPath}`
        : `Transcribe je tražio „${setupName}” uz sebe, ali ga ondje nema.\n\nDržite Transcribe.exe u mapi „Transcribe” koju ste raspakirali, uz „${setupName}” i mapu „models”, pa pokušajte ponovno.\n\nTraženo u: ${scriptPath}`;
    },

    // Instagram
    connectInstagramMenu: 'Poveži Instagram…',
    disconnectInstagramMenu: 'Odspoji Instagram',
    instagramConnectedTitle: 'Instagram je povezan',
    instagramConnectedBody: 'Instagram poveznice sada će se preuzimati pomoću vaše prijave. Možete se odspojiti bilo kada iz izbornika Datoteka.',
    instagramNotConnectedTitle: 'Nije povezano',
    instagramNotConnectedBody: 'Još niste prijavljeni na Instagram, pa Instagram poveznice i dalje mogu ne uspjeti. Ponovno odaberite „Poveži Instagram…” i dovršite prijavu.',
    instagramDisconnectedTitle: 'Instagram je odspojen',
    instagramDisconnectedBody: 'Vaša Instagram prijava obrisana je iz ove aplikacije.',

    // Trajanja i procjena vremena
    durationPhrase(seconds) {
      if (seconds < 60) return 'manje od minute';
      const m = Math.max(1, Math.round(seconds / 60));
      if (m < 60) return `${m} min`;
      const h = Math.floor(m / 60);
      const r = m % 60;
      return r === 0 ? `${h} h` : `${h} h ${r} min`;
    },
    etaUnderMinute: 'još manje od minute',
    etaMinutes(m) { return `još otprilike ${m} min`; },
    etaHours(h) { return `još otprilike ${h} h`; },
    etaHoursMinutes(h, r) { return `još otprilike ${h} h ${r} min`; },
  };
};
