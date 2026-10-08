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
  // Frames are downloaded as compressed blobs (all of them, nearest to the user first) and decoded off the main
  // thread into ImageBitmaps only for a small window around the scroll position, so drawing never waits on decoding.
  const AHEAD = 12, BEHIND = 4;
  class Seq {
    constructor(cv, name, n) {
      this.cv = cv; this.ctx = cv.getContext('2d'); this.n = n;
      this.dir = `assets/frames/${name}/${small ? 'm' : 'd'}/`;
      this.blobs = new Array(n); this.bmps = new Array(n); this.fetching = new Set(); this.decoding = new Set();
      this.target = 0; this.tf = 0; this.drawn = null; this.started = false; this.active = 0; this.live = true;
      this.size(); addEventListener('resize', () => { this.size(); this.drawn = null; this.draw(); });
    }
    size() {
      const r = this.cv.getBoundingClientRect(), k = Math.min(Math.min(devicePixelRatio || 1, 2), 1920 / Math.max(1, r.width));
      this.cv.width = Math.max(1, Math.round(r.width * k)); this.cv.height = Math.max(1, Math.round(r.height * k));
    }
    start() { if (this.started) return; this.started = true; this.next(); }
    url(i) { return this.dir + String(i + 1).padStart(3, '0') + '.webp'; }
    // download the missing frame closest to the user (biased forward), 6 at a time
    next() {
      while (this.active < 6) {
        let pick = -1, bd = 1e9;
        for (let i = 0; i < this.n; i++) {
          if (this.blobs[i] || this.fetching.has(i)) continue;
          const d = i >= this.target ? i - this.target : (this.target - i) * 2;
          if (d < bd) { bd = d; pick = i; }
        }
        if (pick < 0) return;
        const i = pick; this.active++; this.fetching.add(i);
        fetch(this.url(i)).then(r => r.blob()).then(b => { this.blobs[i] = b; }).catch(() => {})
          .finally(() => { this.active--; this.fetching.delete(i); this.decodeWindow(); this.next(); });
      }
    }
    // keep decoded bitmaps only around the current position
    decodeWindow() {
      if (!this.live) return;
      const lo = this.target - BEHIND, hi = this.target + AHEAD;
      for (let i = 0; i < this.n; i++) {
        if (i < lo || i > hi) { if (this.bmps[i]) { this.bmps[i].close && this.bmps[i].close(); this.bmps[i] = null; } continue; }
        if (this.bmps[i] || !this.blobs[i] || this.decoding.has(i)) continue;
        this.decoding.add(i);
        const done = bm => { this.decoding.delete(i); if (bm && this.live && i >= this.target - BEHIND - 2 && i <= this.target + AHEAD + 2) { this.bmps[i] = bm; this.draw(); } else if (bm && bm.close) bm.close(); };
        if (window.createImageBitmap) createImageBitmap(this.blobs[i]).then(done, () => done(null));
        else { const im = new Image(); im.onload = () => done(im); im.src = URL.createObjectURL(this.blobs[i]); }
      }
    }
    // called when the section leaves / enters the screen
    setLive(v) {
      if (v === this.live) return; this.live = v;
      if (!v) { this.bmps.forEach((b, i) => { if (b && b.close) b.close(); this.bmps[i] = null; }); this.decoding.clear(); }
      else this.decodeWindow();
    }
    set(p) {
      const t = clamp(p) * (this.n - 1);
      if (Math.abs(t - this.tf) < 0.02 && this.drawn) return;
      this.tf = t;
      const r = Math.round(t);
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
    paint(im, alpha) {
      const cw = this.cv.width, ch = this.cv.height, iw = im.width || im.naturalWidth, ih = im.height || im.naturalHeight;
      const s = Math.max(cw / iw, ch / ih), w = iw * s, h = ih * s;
      this.ctx.globalAlpha = alpha; this.ctx.drawImage(im, (cw - w) / 2, (ch - h) / 2, w, h);
    }
    // draw the frame below the scroll position, then blend the next one on top by the fraction between them
    draw() {
      if (!this.live) return;
      const i0 = Math.floor(this.tf), a = this.tf - i0;
      const f0 = this.near(i0), f1 = a > 0.03 ? this.near(Math.min(this.n - 1, i0 + 1)) : f0;
      if (f0 < 0) return;
      const key = f0 + ':' + f1 + ':' + Math.round(a * 16);
      if (key === this.drawn) return;
      this.paint(this.bmps[f0], 1);
      if (f1 !== f0) this.paint(this.bmps[f1], a);
      this.ctx.globalAlpha = 1; this.drawn = key;
    }
  }
  const seqs = {};
  $$('canvas[data-seq]').forEach(cv => { seqs[cv.id] = new Seq(cv, cv.dataset.seq, +cv.dataset.n); });
  // start loading each sequence when its section is within ~2 screens (hero starts now)
  seqs.heroCv.start();
  const sio = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { seqs[e.target.dataset.cv].start(); sio.unobserve(e.target); } }), { rootMargin: '200% 0px' });
  $$('[data-cv]').forEach(el => sio.observe(el));

  // ---- Section 1: hero title, then 4 beats
  const s1 = $('#s1'), heroTitle = $('#heroTitle'), cue = $('#cue');
  const s1Beats = $$('.beat', s1);

  // ---- Section 3: crossfade rooms
  const s3 = $('#s3'), layers = $$('.layer', s3), caps = $$('.cap', s3), dots = $$('#dots3 i');

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

  // ---- Section 5: scrubbed video
  const s5 = $('#s5'), s5Beats = $$('.beat', s5);

  const navEl = $('#nav'), galNow = $('#galNow'), galBar = $('#galBar'), figs = $$('figure', track);
  const last = { nav: null, h: -2, i1: -2, i3: -2, gc: -1, gn: '', i5: -2 };
  const setOn = (list, idx) => list.forEach((el, i) => el.classList.toggle('on', i === idx));
  let ticking = false;
  const update = () => {
    ticking = false;

    // nav tint after hero
    const solid = scrollY > innerHeight * 0.9 && !inside(s1) && !inside(s3) && !inside(s5);
    if (solid !== last.nav) { last.nav = solid; navEl.classList.toggle('solid', solid); }

    // only keep decoded frames for sections near the screen
    const near = el => { const r = el.getBoundingClientRect(); return r.bottom > -innerHeight && r.top < innerHeight * 2; };
    seqs.heroCv.setLive(near(s1));
    seqs.locCv.setLive(near(seqs.locCv.cv));
    seqs.lakeCv.setLive(near(s5));

    // S1
    const p1 = progress(s1);
    seqs.heroCv.set(p1);
    const started = p1 > 0.06;
    const i1 = started ? Math.min(3, Math.floor((p1 - 0.06) / 0.94 * 4)) : -1;
    if (i1 !== last.i1) {
      last.i1 = i1; heroTitle.classList.toggle('gone', started); cue.style.opacity = started ? 0 : 1; setOn(s1Beats, i1);
    }

    // S3
    const p3 = progress(s3), i3 = Math.min(3, Math.floor(p3 * 4));
    const n3 = near(s3);
    seqs.room1.setLive(n3 && i3 <= 1); seqs.room2.setLive(n3 && i3 <= 2);
    seqs.room1.set(i3 === 0 ? p3 * 4 : 1); seqs.room2.set(i3 === 1 ? p3 * 4 - 1 : i3 > 1 ? 1 : 0);
    if (i3 !== last.i3) { last.i3 = i3; setOn(layers, i3); setOn(caps, i3); setOn(dots, i3); }

    // S4
    const p4 = progress(gal);
    const max = track.scrollWidth - innerWidth;
    track.style.transform = `translate(${-max * p4}px,-50%)`;
    const gc = Math.min(files.length - 1, Math.floor(p4 * files.length));
    if (gc !== last.gc) {
      if (figs[last.gc]) figs[last.gc].classList.remove('focus');
      figs[gc].classList.add('focus'); last.gc = gc; galNow.textContent = String(gc + 1).padStart(2, '0');
    }
    galBar.style.transform = `scaleX(${p4})`;

    // S2 video plays as it scrolls through the viewport
    const lr = seqs.locCv.cv.getBoundingClientRect();
    seqs.locCv.set((innerHeight - lr.top) / (innerHeight + lr.height));

    // S5
    const p5 = progress(s5);
    seqs.lakeCv.set(p5);
    const i5 = Math.min(2, Math.floor(p5 * 3));
    const on5 = p5 > 0 ? i5 : -1;
    if (on5 !== last.i5) { last.i5 = on5; setOn(s5Beats, on5); }
  };
  const inside = el => { const r = el.getBoundingClientRect(); return r.top < 60 && r.bottom > 60; };
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
