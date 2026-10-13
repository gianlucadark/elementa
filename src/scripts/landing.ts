import { services, week } from '../content/landing';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Sections settle in once, as they reach the reader. */
{
  const items = document.querySelectorAll<HTMLElement>('[data-reveal]');
  if (reduced || !('IntersectionObserver' in window)) items.forEach((el) => el.classList.add('is-in'));
  else {
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } }),
      { rootMargin: '0px 0px -12% 0px' },
    );
    items.forEach((el) => io.observe(el));
  }
}

/* Restaurant time: the hours are Fondi's, whatever the visitor's clock says. */
const minutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const weekdays = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const isOpenDay = (weekday: number) => week[(weekday + 6) % 7].open; // week is Monday first

function romeNow() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date())
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
  const weekday = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day)).getUTCDay(); // calendar day in Rome
  return { weekday, minute: +parts.hour * 60 + +parts.minute };
}

function nextOpening(weekday: number) {
  for (let d = 1; d <= 7; d++) {
    const w = (weekday + d) % 7;
    if (isOpenDay(w)) return `${d === 1 ? 'domani' : weekdays[w]} alle ${services[0].opens}`;
  }
  return '';
}

function openStatus() {
  const { weekday, minute } = romeNow();
  if (!isOpenDay(weekday)) return { open: false, text: `Oggi siamo chiusi. Riapriamo ${nextOpening(weekday)}` };
  for (const s of services) {
    if (minute >= minutes(s.opens) && minute < minutes(s.closes)) return { open: true, text: `Aperti ora, a ${s.label} fino alle ${s.closes}` };
    if (minute < minutes(s.opens)) return { open: false, text: s === services[0] ? `Oggi apriamo alle ${s.opens}` : `Riapriamo alle ${s.opens} per la ${s.label}` };
  }
  return { open: false, text: `Riapriamo ${nextOpening(weekday)}` };
}

function renderStatus() {
  const { open, text } = openStatus();
  document.querySelectorAll<HTMLElement>('[data-open-status]').forEach((el) => {
    el.dataset.state = open ? 'open' : 'closed';
    el.querySelector('[data-open-status-text]')!.textContent = text;
  });
  const today = romeNow().weekday;
  document.querySelectorAll<HTMLElement>('.hours tr').forEach((tr) => tr.toggleAttribute('data-today', Number(tr.dataset.weekday) === today));
}
renderStatus();
setInterval(renderStatus, 60_000);

/* Phone navigation: a sheet with every section, opened from the header. */
{
  const sheet = document.querySelector<HTMLDialogElement>('#nav-sheet');
  const toggle = document.querySelector<HTMLButtonElement>('.menu-toggle');
  if (sheet && toggle && typeof sheet.showModal === 'function') {
    toggle.addEventListener('click', () => sheet.showModal());
    sheet.querySelector('.nav-sheet__close')!.addEventListener('click', () => sheet.close());
    sheet.addEventListener('click', (e) => {
      const link = (e.target as HTMLElement).closest('a');
      if (link?.hash) sheet.close();
      if (e.target === sheet) sheet.close();
    });
    matchMedia('(min-width: 701px)').addEventListener('change', (e) => e.matches && sheet.close());
  }
}
