(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  // smooth scroll
  const lenis = window.Lenis && !matchMedia('(prefers-reduced-motion:reduce)').matches ? new Lenis({ lerp: 0.1 }) : null;
  if (lenis) { const raf = t => { lenis.raf(t); requestAnimationFrame(raf); }; requestAnimationFrame(raf); }
  $$('a[href^="#"]').forEach(a => a.addEventListener('click', e => {
    const t = $(a.getAttribute('href')); if (!t) return;
    e.preventDefault(); lenis ? lenis.scrollTo(t) : t.scrollIntoView({ behavior: 'smooth' });
  }));

  // split headlines into rising lines
  $$('.beat h2, .cap h2').forEach(h => {
    h.innerHTML = h.innerHTML.split(/<br\s*\/?>/i).map(l => `<span class="ln"><span>${l}</span></span>`).join('');
  });

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

  // 0..1 progress through a pinned section
  const progress = el => {
    const r = el.getBoundingClientRect();
    return clamp(-r.top / (r.height - innerHeight));
  };

  // ---- Frame-sequence player (replaces scroll-scrubbed video: lighter, smoother, loads progressively)
  const nc = navigator.connection || {};
  const small = innerWidth <= 800 || nc.saveData || /(^|-)2g|3g/.test(nc.effectiveType || '');
  // Frames load through one shared queue, 4 at a time, for whichever sequence is closest to the screen. Each sequence
  // loads coarse-to-fine (every 16th frame, then every 8th, 4th, 2nd, the rest), so the whole clip can be scrubbed
  // almost at once and just gets smoother as the gaps fill in. Only frames around the scroll position are kept as
  // decoded ImageBitmaps (decoded off the main thread), so drawing never waits on a decode.
  const SPAN = 8;
  const order = n => {
    const out = [0, n - 1], seen = new Set(out);
    for (let step = 16; step >= 1; step >>= 1) for (let i = 0; i < n; i += step) if (!seen.has(i)) { seen.add(i); out.push(i); }
    return out;
  };
  class Seq {
    constructor(cv, name, n) {
      this.cv = cv; this.ctx = cv.getContext('2d'); this.n = n; this.host = cv.closest('section');
      this.blend = cv.hasAttribute('data-blend'); this.span = Math.max(SPAN, Math.round(n / 16)); this.pos = 0;
      this.dir = `assets/frames/${name}/${small ? 'm' : 'd'}/`;
      this.imgs = new Array(n); this.bmps = new Array(n); this.decoding = new Set(); this.keep = new Set();
      this.queue = order(n); this.target = 0; this.drawn = -1; this.live = true;
      this.size();
    }
    size() {
      const r = this.cv.getBoundingClientRect(), k = Math.min(Math.min(devicePixelRatio || 1, 2), 1920 / Math.max(1, r.width));
      this.cv.width = Math.max(1, Math.round(r.width * k)); this.cv.height = Math.max(1, Math.round(r.height * k));
    }
    url(i) { return this.dir + String(i + 1).padStart(3, '0') + '.webp'; }
    // next frame to request: the one under the scroll position if it's still missing, else the next in coarse-to-fine order
    take() { const k = this.queue.indexOf(this.target); return this.queue.splice(k > 0 ? k : 0, 1)[0]; }
    // frames are fetched as blobs so createImageBitmap decodes them off the main thread;
    // fetch fails when the page is opened straight from disk (file://), so fall back to <img> there
    load(i, done) {
      const ok = src => { this.imgs[i] = src; this.decodeWindow(); done(); };
      fetch(this.url(i)).then(r => r.ok ? r.blob() : Promise.reject()).then(ok, () => {
        const im = new Image(); im.onload = () => ok(im); im.onerror = done; im.src = this.url(i);
      });
    }
    // keep decoded bitmaps around the current position, plus the nearest loaded frame on each side of it
    decodeWindow() {
      if (!this.live) return;
      const t = this.target, keep = new Set();
      for (let i = Math.max(0, t - this.span); i <= Math.min(this.n - 1, t + this.span); i++) if (this.imgs[i]) keep.add(i);
      for (let i = t; i >= 0; i--) if (this.imgs[i]) { keep.add(i); break; }
      for (let i = t; i < this.n; i++) if (this.imgs[i]) { keep.add(i); break; }
      this.keep = keep;
      this.bmps.forEach((b, i) => { if (b && !keep.has(i)) { b.close && b.close(); this.bmps[i] = null; } });
      keep.forEach(i => {
        if (this.bmps[i] || this.decoding.has(i)) return;
        this.decoding.add(i);
        const done = bm => { this.decoding.delete(i); if (bm && this.live && this.keep.has(i)) { this.bmps[i] = bm; this.draw(); } else if (bm && bm.close) bm.close(); };
        const src = this.imgs[i];
        if (!(src instanceof Blob)) src.decode().then(() => done(src), () => done(null));
        else if (window.createImageBitmap) createImageBitmap(src).then(done, () => done(null));
        else { const im = new Image(); im.onload = () => done(im); im.onerror = () => done(null); im.src = URL.createObjectURL(src); }
      });
    }
    // called when the section leaves / enters the screen
    setLive(v) {
      if (v === this.live) return; this.live = v;
      if (!v) { this.bmps.forEach((b, i) => { if (b && b.close) b.close(); this.bmps[i] = null; }); this.decoding.clear(); this.keep.clear(); }
      else this.decodeWindow();
    }
    set(p) {
      this.pos = clamp(p) * (this.n - 1);
      const r = Math.round(this.pos);
      if (r !== this.target) { this.target = r; this.decodeWindow(); }
      this.draw();
    }
    near(i) {
      for (let k = 0; k < this.n; k++) {
        if (this.bmps[i + k]) return i + k;
        if (this.bmps[i - k]) return i - k;
      }
      return -1;
    }
    // draw the frame under the scroll position (or the closest one already decoded);
    // blend sequences also dissolve into the next frame by the fractional part, so slow scrolling stays continuous
    draw() {
      if (!this.live) return;
      if (this.blend) {
        const lo = Math.floor(this.pos), hi = Math.min(this.n - 1, lo + 1), a = Math.round((this.pos - lo) * 12) / 12;
        if (this.bmps[lo] && this.bmps[hi]) {
          if (lo + a === this.drawn) return;
          this.paint(this.bmps[lo], 1); if (a > 0) this.paint(this.bmps[hi], a);
          this.drawn = lo + a; return;
        }
      }
      const f = this.near(this.target);
      if (f < 0 || f === this.drawn) return;
      this.paint(this.bmps[f], 1); this.drawn = f;
    }
    paint(im, alpha) {
      const cw = this.cv.width, ch = this.cv.height, iw = im.width || im.naturalWidth, ih = im.height || im.naturalHeight;
      const k = Math.max(cw / iw, ch / ih), w = iw * k, h = ih * k;
      this.ctx.globalAlpha = alpha; this.ctx.drawImage(im, (cw - w) / 2, (ch - h) / 2, w, h); this.ctx.globalAlpha = 1;
    }
  }
  const seqs = {}, seqList = $$('canvas[data-seq]').map(cv => (seqs[cv.id] = new Seq(cv, cv.dataset.seq, +cv.dataset.n)));
  addEventListener('resize', () => seqList.forEach(s => { s.size(); s.drawn = -1; s.draw(); }));
  const away = el => { const r = el.getBoundingClientRect(); return r.top > innerHeight ? r.top - innerHeight : r.bottom < 0 ? -r.bottom : 0; };
  let loading = 0;
  const pump = () => {
    while (loading < 4) {
      let s = null, best = Infinity;
      for (const q of seqList) if (q.queue.length) { const d = away(q.host); if (d < best) { best = d; s = q; } }
      if (!s) return;
      loading++; s.load(s.take(), () => { loading--; pump(); });
    }
  };
  pump();

  // ---- Section 1: hero title, then 4 beats
  const s1 = $('#s1'), heroTitle = $('#heroTitle'), cue = $('#cue');
  const s1Beats = $$('.beat', s1);

  // ---- Section 3: crossfade rooms
  const s3 = $('#s3'), room4 = $('#room4'), caps = $$('.cap', s3), dots = $$('#dots3 i');

  // ---- Section 4: gallery
  const captions = [
    ['Aerial View', 'Raven Lake at golden hour'], ['Calm Water', 'Reflections across the lake'],
    ['The Island', 'Pines on the water'], ['Open Sky', 'Still, clear mornings'],
    ['Over the Lake', 'Looking down the shoreline'], ['The Marina', 'Raven Lake Landing'],
    ['The Boardwalk', 'Walking out to the boats'], ['Private Dock', 'Your own landing'],
    ['The Shoreline', 'Granite, cedar and sun'], ['Garden Cabin', 'A small place to retreat'],
    ['The Cottage', 'Seen from the hill'], ['Lakeside', 'Cottage and dock'],
    ['The Deck', 'Dining over the water'], ['Back Deck', 'Shaded and screened'],
    ['Screened Porch', 'Lake air, no bugs'], ['Oak Lounge', 'Facing the stairs'],
    ['Living Room', 'Wood stove and wicker'], ['Kitchen & Dining', 'Open plan'],
    ['The Dining Table', 'Lake views from every seat'], ['The Sunroom', 'Morning light'],
    ['The Workshop', 'Room for projects'], ['Primary Bedroom', 'Walkout to the deck'],
    ['Guest Bedroom', 'Quiet and bright'], ['Bunk Room', 'Made for the kids'],
    ['Upper Bedroom', 'Pine ceilings'], ['Reading Nook', 'Shelves and bunks']
  ];
  const track = $('#track'), gal = $('#gallery');
  const files = Array.from({ length: 28 }, (_, i) => String(i + 1).padStart(2, '0')).filter(n => !['04', '10'].includes(n));
  files.forEach((n, i) => {
    const f = document.createElement('figure');
    f.dataset.n = String(i + 1).padStart(2, '0');
    const c = captions[i] || ['Raven Lake', ''];
    f.innerHTML = `<img loading="${i < 3 ? 'eager' : 'lazy'}" src="assets/gallery/${n}.webp" alt="${c[0]}" width="1200" height="800" decoding="async"><figcaption><b>${c[0]}</b><span>${c[1]}</span></figcaption>`;
    track.appendChild(f);
  });
  $('#galTotal').textContent = String(files.length).padStart(2, '0');
  // fetch every gallery photo (and decode it off the main thread) before the visitor reaches the gallery
  new IntersectionObserver((es, o) => { if (!es[0].isIntersecting) return; o.disconnect();
    $$('img', track).forEach(im => { im.loading = 'eager'; im.decode().catch(() => {}); });
  }, { rootMargin: '150% 0px' }).observe(gal);

  // ---- Section 5: scrubbed video
  const s5 = $('#s5'), s5Beats = $$('.beat', s5);

  const navEl = $('#nav'), galNow = $('#galNow'), galBar = $('#galBar'), figs = $$('figure', track);
  const last = { nav: null, i1: -2, i3: -2, c3: -2, rv: -1, gc: -1, i5: -2 };
  const setOn = (list, idx) => list.forEach((el, i) => el.classList.toggle('on', i === idx));
  let galMax = 0;
  let figBox = [];
  const measure = () => { galMax = track.scrollWidth - innerWidth; figBox = figs.map(f => [f.offsetLeft, f.offsetWidth]); };
  const still = matchMedia('(prefers-reduced-motion:reduce)').matches;
  measure(); addEventListener('resize', measure);
  let ticking = false;
  const update = () => {
    ticking = false;
    // read all positions first, then write: mixing reads and writes forces a layout on every frame
    const H = innerHeight, r1 = s1.getBoundingClientRect(), r3 = s3.getBoundingClientRect(), r4 = gal.getBoundingClientRect(),
      r5 = s5.getBoundingClientRect();
    const prog = r => clamp(-r.top / (r.height - H));
    const near = r => r.bottom > -H && r.top < H * 2;
    const inside = r => r.top < 60 && r.bottom > 60;
    const p1 = prog(r1), p3 = prog(r3), p4 = prog(r4), p5 = prog(r5);

    // nav tint after hero
    const solid = scrollY > H * 0.9 && !inside(r1) && !inside(r3) && !inside(r5);
    if (solid !== last.nav) { last.nav = solid; navEl.classList.toggle('solid', solid); }

    // only keep decoded frames for sections near the screen
    seqs.heroCv.setLive(near(r1));
    seqs.tourCv.setLive(near(r3));
    seqs.lakeCv.setLive(near(r5));

    // S1
    seqs.heroCv.set(p1);
    const started = p1 > 0.06;
    const i1 = started ? Math.min(3, Math.floor((p1 - 0.06) / 0.94 * 4)) : -1;
    if (i1 !== last.i1) {
      last.i1 = i1; heroTitle.classList.toggle('gone', started); cue.style.opacity = started ? 0 : 1; setOn(s1Beats, i1);
    }

    // S3: one clip, scrubbed in two legs (kitchen -> stove room -> seating area). The page holds still between legs so each
    // caption sits on a steady frame; captions only show while still (one at a time), then the last photo rises over the clip.
    const seg = (a, b) => clamp((p3 - a) / (b - a)), BND = 120 / (seqs.tourCv.n - 1);
    seqs.tourCv.set(BND * seg(0.09, 0.33) + (1 - BND) * seg(0.47, 0.71));
    const c3 = p3 < 0.075 ? 0 : p3 >= 0.35 && p3 < 0.45 ? 1 : p3 >= 0.73 && p3 < 0.78 ? 2 : p3 >= 0.91 ? 3 : -1;
    if (c3 !== last.c3) { last.c3 = c3; setOn(caps, c3); }
    const i3 = p3 < 0.21 ? 0 : p3 < 0.59 ? 1 : p3 < 0.84 ? 2 : 3;
    if (i3 !== last.i3) { last.i3 = i3; setOn(dots, i3); }
    const rv = Math.round(seg(0.8, 0.88) * 200) / 200;
    if (rv !== last.rv) { last.rv = rv; room4.style.clipPath = `inset(${(1 - rv) * 100}% 0 0 0)`; }

    // S4: the photo nearest the centre is the focus; photos on screen drift slightly inside their frames
    const x = galMax * p4, mid = innerWidth / 2;
    track.style.transform = `translate(${-x}px,-50%)`;
    let gc = 0, bd = Infinity;
    figBox.forEach(([l, w], i) => {
      const c = l + w / 2 - x - mid;
      if (Math.abs(c) < bd) { bd = Math.abs(c); gc = i; }
      if (!still && l - x < innerWidth && l + w - x > 0) figs[i].firstChild.style.transform = `translate3d(${(-c / innerWidth * 6).toFixed(2)}%,0,0) scale(1.14)`;
    });
    if (gc !== last.gc) {
      if (figs[last.gc]) figs[last.gc].classList.remove('focus');
      figs[gc].classList.add('focus'); galNow.textContent = String(gc + 1).padStart(2, '0');
      if (!still && last.gc >= 0) galNow.animate([{ transform: `translateY(${gc > last.gc ? 100 : -100}%)` }, { transform: 'none' }], { duration: 550, easing: 'cubic-bezier(.2,.7,.2,1)' });
      last.gc = gc;
    }
    galBar.style.transform = `scaleX(${p4})`;

    // S5
    seqs.lakeCv.set(p5);
    const i5 = Math.min(2, Math.floor(p5 * 3));
    const on5 = p5 > 0 ? i5 : -1;
    if (on5 !== last.i5) { last.i5 = on5; setOn(s5Beats, on5); }
  };
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  addEventListener('resize', update);
  update();

  // reveal on scroll
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.15 });
  $$('.reveal').forEach(el => io.observe(el));

  // ---- Contact form + survey
  const form = $('#form'), status = $('#status'), dlg = $('#survey');
  let survey = null;
  $('#surveyBtn').onclick = () => dlg.showModal();
  $('#surveyCancel').onclick = () => dlg.close();
  $('#surveyForm').addEventListener('submit', e => {
    survey = Object.fromEntries(new FormData(e.target));
    status.textContent = 'Thanks — your survey answers will be sent with your message.';
  });
  $$('[data-tour]').forEach(a => a.addEventListener('click', () => setTimeout(() => $('input[name=name]').focus({ preventScroll: true }), 700)));

  form.addEventListener('submit', e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    const bad = ['name', 'email'].filter(k => !d[k] || (k === 'email' && !/^\S+@\S+\.\S+$/.test(d[k])));
    $$('input', form).forEach(i => i.classList.toggle('bad', bad.includes(i.name)));
    if (bad.length) { status.textContent = 'Please add your name and a valid email.'; return; }
    // No backend yet: log the payload so it can be wired to an endpoint.
    console.log('Inquiry', { ...d, survey });
    status.textContent = `Thank you, ${d.name.split(' ')[0]} — the agent will be in touch shortly.`;
    form.reset(); survey = null;
  });
})();

// loader: hide as soon as the first hero frame is on screen (or after 2.5s)
(() => {
  const l = document.getElementById('loader'), im = document.getElementById('heroPoster');
  const hide = () => l.classList.add('done');
  im.complete ? hide() : im.addEventListener('load', hide, { once: true });
  setTimeout(hide, 2500);
})();
// count-up stats not numeric except year
(() => {
  const b = [...document.querySelectorAll('.stat b')].find(x => /^\d+$/.test(x.textContent));
  if (!b) return;
  const end = +b.textContent; let done = false;
  new IntersectionObserver((es, o) => es.forEach(e => {
    if (!e.isIntersecting || done) return; done = true; o.disconnect();
    const t0 = performance.now();
    const step = t => { const p = Math.min(1, (t - t0) / 1400); b.textContent = Math.round(1900 + (end - 1900) * (1 - Math.pow(1 - p, 3))); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }), { threshold: 0.6 }).observe(b);
})();
