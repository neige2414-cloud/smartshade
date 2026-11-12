'use strict';
/* SmartShade 대시보드
   - 태양 위치 계산(NOAA 근사식) → 목표 방위·틸트
   - ESP32 A/B/C와 줄 단위 JSON 통신 (지금: USB Web Serial, 나중: Wi-Fi WebSocket)
   - 연결되지 않은 보드는 화면 시뮬레이션(SIM)으로 대신 동작
*/

// ═══════════ 설정 (현장에서 바꿀 값) ═══════════
const CFG = {
  lat: 37.5665, lon: 126.9780,      // 설치 위치
  pingMs: 500,                      // 보드 워치독 유지 (보드는 1.5 s 끊기면 정지)
  staleMs: 3000,                    // 이 시간 동안 데이터가 없으면 '응답 없음'
  autoPeriodMs: 5000,               // 자동 추적 명령 주기
  autoMinMoveDeg: 1.0,              // 이보다 작은 변화는 보내지 않음
  zMin: 0, zMax: 60,                // 틸트 기구 범위 (B 펌웨어 Z_MIN/MAX와 같게)
  // 태양 고도 → 차양막 틸트. 판이 태양을 정면으로 마주 보게 하면 90° − 고도.
  // 기구에서 틸트 0°가 '수평'이 아니면 여기만 고치면 됨.
  tiltFromElevation: el => 90 - el,
  rollerJogMs: 3000,
  usbFilters: [{ usbVendorId: 0x10C4 }, { usbVendorId: 0x1A86 }, { usbVendorId: 0x0403 }, { usbVendorId: 0x303A }],
};

// ═══════════ 도우미 ═══════════
const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ok = v => typeof v === 'number' && isFinite(v);
const fmt = (v, d = 1) => ok(v) ? v.toFixed(d) : '--';
const wrap360 = a => ((a % 360) + 360) % 360;
const wrap180 = a => { a = wrap360(a); return a > 180 ? a - 360 : a; };
const RAD = Math.PI / 180;
const DIR16 = ['북', '북북동', '북동', '동북동', '동', '동남동', '남동', '남남동', '남', '남남서', '남서', '서남서', '서', '서북서', '북서', '북북서'];
const dirName = az => DIR16[Math.round(wrap360(az) / 22.5) % 16];

// ═══════════ 태양 위치 (NOAA Solar Calculator 근사) ═══════════
function sunPosition(date, lat, lon) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = wrap360(280.46646 + T * (36000.76983 + T * 0.0003032));
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T))
          + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T)
          + Math.sin(3 * M * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));
  const y = Math.tan(eps * RAD / 2) ** 2;
  const eqTime = 4 / RAD * (y * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD)
    + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD)
    - 0.5 * y * y * Math.sin(4 * L0 * RAD) - 1.25 * e * e * Math.sin(2 * M * RAD)); // 분
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const tst = ((utcMin + eqTime + 4 * lon) % 1440 + 1440) % 1440;      // 진태양시
  const ha = (tst / 4 - 180) * RAD;                                      // 시간각
  const phi = lat * RAD;
  const cosZ = clamp(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha), -1, 1);
  let el = 90 - Math.acos(cosZ) / RAD;
  if (el > -1) el += 1.02 / Math.tan((el + 10.3 / (el + 5.11)) * RAD) / 60;  // 대기 굴절(Bennett)
  const az = wrap360(Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / RAD + 180);
  return { az, el, decl: decl / RAD };
}

// ═══════════ 시연 시각 (실시간 / 직접 지정 + 배속) ═══════════
const timeCtl = { live: true, base: 0, realBase: 0, speed: 1 };
function simNow() {
  if (timeCtl.live && timeCtl.speed === 1) return new Date();
  return new Date(timeCtl.base + (Date.now() - timeCtl.realBase) * timeCtl.speed);
}
function setSimTime(dateMs, speed = timeCtl.speed) {
  timeCtl.base = dateMs; timeCtl.realBase = Date.now(); timeCtl.speed = speed; timeCtl.live = false;
}
const kstParts = d => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
}).formatToParts(d).map(p => [p.type, p.value]));

// ═══════════ 기록 ═══════════
function log(msg, kind = 'info', src = 'SYS') {
  const box = $('logs');
  const row = document.createElement('div');
  row.className = `log ${kind}`;
  const t = kstParts(new Date());
  row.innerHTML = `<time>${t.hour}:${t.minute}:${t.second}</time><b>${src}</b><span></span>`;
  row.lastChild.textContent = msg;
  box.prepend(row);
  while (box.children.length > 200) box.lastChild.remove();
}

// ═══════════ 보드 / 링크 ═══════════
const BOARDS = {
  A: { name: 'A 롤러', link: null, tele: null, seen: 0 },
  B: { name: 'B 추적', link: null, tele: null, seen: 0 },
  C: { name: 'C 좌판', link: null, tele: null, seen: 0 },
};

class Link {
  constructor(kind, label) { this.kind = kind; this.label = label; this.boardId = null; this.alive = true; }
  gotLine(line) { onLine(this, line); }
  gone() {
    this.alive = false;
    const b = this.boardId && BOARDS[this.boardId];
    if (b && b.link === this) { b.link = null; b.tele = null; log(`${b.name} 연결 해제 → SIM으로 전환`, 'warn', this.boardId); }
  }
}

class SerialLink extends Link {
  constructor(port) {
    super('USB', 'USB');
    this.port = port;
    const i = port.getInfo();
    if (i.usbVendorId) this.label = `USB ${i.usbVendorId.toString(16)}:${(i.usbProductId || 0).toString(16)}`;
  }
  async open() {
    await this.port.open({ baudRate: 115200, bufferSize: 8192 });
    // DevKit 자동 리셋 회로: DTR/RTS를 둘 다 내려 보드가 리셋/부트모드로 들어가지 않게 함
    try { await this.port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch (_) {}
    this.writer = this.port.writable.getWriter();
    this.readLoop();
    setTimeout(() => this.send({ cmd: 'hello' }), 300);
    setTimeout(() => { if (!this.boardId) this.send({ cmd: 'hello' }); }, 1800);
  }
  async readLoop() {
    const dec = new TextDecoder();
    let buf = '';
    while (this.alive && this.port.readable) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (line) this.gotLine(line);
          }
          if (buf.length > 8192) buf = '';
        }
      } catch (e) {
        log(`시리얼 읽기 오류: ${e.message}`, 'warn', this.boardId || 'USB');
        break;                                   // 케이블 분리 등
      } finally { try { this.reader.releaseLock(); } catch (_) {} }
    }
    this.close();
  }
  send(obj) {
    if (!this.writer) return;
    this.writer.write(new TextEncoder().encode(JSON.stringify(obj) + '\n')).catch(() => {});
  }
  async close() {
    if (!this.alive) return;
    this.gone();
    try { await this.reader?.cancel(); } catch (_) {}
    try { this.writer?.releaseLock(); } catch (_) {}
    try { await this.port.close(); } catch (_) {}
    serialLinks.delete(this.port);
  }
}

// 나중에 무선으로 갈 때: 보드 펌웨어가 ws://<IP>:81 로 같은 JSON 줄을 주고받으면 그대로 동작
class WsLink extends Link {
  constructor(url) { super('Wi-Fi', url); this.url = url; this.manual = false; }
  open() {
    this.alive = true;
    const ws = this.ws = new WebSocket(this.url);
    ws.onopen = () => { log(`Wi-Fi 연결됨: ${this.url}`, 'ok', 'NET'); this.send({ cmd: 'hello' }); };
    ws.onmessage = ev => String(ev.data).split('\n').map(s => s.trim()).filter(Boolean).forEach(l => this.gotLine(l));
    ws.onclose = () => {
      this.gone();
      if (!this.manual) setTimeout(() => this.open(), 3000);   // 자동 재접속
    };
    ws.onerror = () => {};
  }
  send(obj) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj)); }
  close() { this.manual = true; this.ws?.close(); }
}

function onLine(link, line) {
  if (line[0] !== '{') {                            // JSON이 아닌 디버그 출력
    if (/[�\u0000-\u0008]/.test(line)) return; // 부팅 시 ROM 잡음
    log(line, 'dev', link.boardId || link.label);
    return;
  }
  let m;
  try { m = JSON.parse(line); } catch { log(`깨진 JSON: ${line.slice(0, 80)}`, 'warn', link.boardId || link.label); return; }
  const id = m.id, b = BOARDS[id];
  if (!b) return;
  if (link.boardId !== id) {
    if (b.link && b.link !== link && b.link.alive) log(`${b.name}: 다른 연결로 교체`, 'warn', id);
    link.boardId = id; b.link = link; b.tele = null;
    log(`${b.name} 인식 (${link.kind} · ${link.label})`, 'ok', id);
  }
  b.seen = Date.now();
  if (m.ev) { log(m.msg, m.ev === 'error' ? 'err' : m.ev === 'warn' ? 'warn' : 'info', id); return; }
  if (m.hello) { b.info = m; return; }
  b.tele = m;
  renderBoard(id);
}

function send(id, obj, quiet = false) {
  const b = BOARDS[id];
  if (b.link) b.link.send(obj); else SIM.handle(id, obj);
  if (!quiet) log(`${b.link ? '→' : '→ (SIM)'} ${JSON.stringify(obj)}`, 'cmd', id);
}

// ═══════════ USB 연결 ═══════════
const serialLinks = new Map();
async function openPort(port) {
  if (serialLinks.has(port)) return;
  const link = new SerialLink(port);
  serialLinks.set(port, link);
  try { await link.open(); log(`포트 열림 (${link.label}) · 보드 확인 중…`, 'info', 'USB'); }
  catch (e) {
    serialLinks.delete(port);
    log(`포트 열기 실패: ${e.message} — Arduino 시리얼 모니터나 다른 탭이 포트를 쓰고 있지 않은지 확인`, 'err', 'USB');
  }
}
async function initSerial() {
  if (!('serial' in navigator)) {
    $('btnSerial').disabled = true;
    $('serialHint').textContent = '이 브라우저는 USB 연결(Web Serial)을 지원하지 않습니다. PC용 Chrome 또는 Edge로 여세요.';
    return;
  }
  $('btnSerial').onclick = async () => {
    try { await openPort(await navigator.serial.requestPort({ filters: CFG.usbFilters })); }
    catch (e) { if (e.name !== 'NotFoundError') log(e.message, 'err', 'USB'); }
  };
  navigator.serial.addEventListener('connect', e => { log('USB 장치 꽂힘', 'info', 'USB'); setTimeout(() => openPort(e.target), 500); });
  navigator.serial.addEventListener('disconnect', e => serialLinks.get(e.target)?.close());
  for (const p of await navigator.serial.getPorts()) openPort(p);   // 이전에 허용한 포트 자동 연결
}

// ═══════════ Wi-Fi 연결 ═══════════
const wsLinks = new Map();
$('btnWs').onclick = () => {
  const url = $('wsUrl').value.trim();
  if (!/^wss?:\/\//.test(url)) { log('주소는 ws:// 로 시작해야 합니다', 'warn', 'NET'); return; }
  if (wsLinks.has(url)) { wsLinks.get(url).close(); wsLinks.delete(url); log(`Wi-Fi 연결 끊음: ${url}`, 'info', 'NET'); return; }
  const l = new WsLink(url); wsLinks.set(url, l); l.open();
};

// ═══════════ 시뮬레이션 (연결 안 된 보드 대신) ═══════════
const SIM = {
  B: { az: 180, azT: 180, ref: 180, z: 0, zT: 0 },
  A: { enc: [0, 0], run: [0, 0], until: [0, 0], wind: 1.2 },
  C: { mode: 'OFF', seat: [29.6, 30.2, 29.9], hx: [31, 31], air: 27.5, rh: 58, duty: 0, fan: false },
  handle(id, o) {
    const s = this[id];
    if (o.cmd === 'ping' || o.cmd === 'hello') return;
    if (id === 'B') {
      const rel = a => clamp(wrap180(a - s.ref), -170, 170);
      if (o.cmd === 'stop') { s.azT = s.az; s.zT = s.z; }
      if (o.cmd === 'x_jog') s.azT = s.ref + clamp(wrap180(s.azT - s.ref) + o.deg, -170, 170);
      if (o.cmd === 'x_goto') s.azT = s.ref + rel(o.az);
      if (o.cmd === 'x_zero') { s.ref = o.az; s.az = s.azT = o.az; }
      if (o.cmd === 'z_jog') s.zT = clamp(s.zT + o.deg, CFG.zMin, CFG.zMax);
      if (o.cmd === 'z_goto') s.zT = clamp(o.deg, CFG.zMin, CFG.zMax);
      if (o.cmd === 'z_zero') s.z = s.zT = o.deg;
    }
    if (id === 'A') {
      if (o.cmd === 'stop') s.run = [0, 0];
      if (o.cmd === 'roller') { const n = o.n - 1; s.run[n] = o.dir === 'open' ? 1 : -1; s.until[n] = Date.now() + o.ms; }
    }
    if (id === 'C') {
      if (o.cmd === 'mode' && s.mode !== 'FAULT') s.mode = o.value;
      if (o.cmd === 'stop') s.mode = 'OFF';
      if (o.cmd === 'fault_reset' && s.mode === 'FAULT') s.mode = 'OFF';
    }
  },
  tick(dt) {
    const sun = sunPosition(simNow(), CFG.lat, CFG.lon);
    if (!BOARDS.B.link) {
      const s = this.B, step = (cur, tgt, v) => cur + clamp(tgt - cur, -v * dt, v * dt);
      s.az = step(s.az, s.azT, 20); s.z = step(s.z, s.zT, 2);
      const lux = [0, 90, 180, 270].map(d => {
        if (sun.el <= 0) return 5 + Math.random() * 3;
        const sinEl = Math.sin(sun.el * RAD);
        return 60000 * sinEl * Math.max(0, Math.cos(wrap180(sun.az - d) * RAD)) * Math.cos(sun.el * RAD) + 12000 * sinEl + Math.random() * 200;
      });
      BOARDS.B.tele = { sim: true, x: { az: wrap360(s.az), tgt: wrap360(s.azT), moving: Math.abs(s.az - s.azT) > 0.05 },
        z: { deg: s.z, tgt: s.zT, moving: Math.abs(s.z - s.zT) > 0.05, est: true }, lux };
      renderBoard('B');
    }
    if (!BOARDS.A.link) {
      const s = this.A;
      for (let n = 0; n < 2; n++) {
        if (s.run[n] && Date.now() > s.until[n]) s.run[n] = 0;
        s.enc[n] = clamp(s.enc[n] + s.run[n] * 400 * dt, 0, 4000);
      }
      s.wind = clamp(s.wind + (Math.random() - 0.5) * 0.3, 0, 6);
      BOARDS.A.tele = { sim: true, r: s.enc.map((e, n) => ({ enc: Math.round(e), run: ['close', 'stop', 'open'][s.run[n] + 1], pct: e / 40 })), wind: s.wind };
      renderBoard('A');
    }
    if (!BOARDS.C.link) {
      const s = this.C;
      const g = 17.62 * s.air / (243.12 + s.air) + Math.log(s.rh / 100);
      const dew = 243.12 * g / (17.62 - g);
      const active = s.mode === 'COOL' || s.mode === 'HEAT';
      const target = s.mode === 'COOL' ? Math.max(26, dew + 3) : s.mode === 'HEAT' ? 34 : NaN;
      const avg = s.seat.reduce((a, b) => a + b) / 3;
      const err = s.mode === 'COOL' ? avg - target : target - avg;
      s.duty = active && err > 0.5 ? clamp((err - 0.5) * 205, 0, 700) : 0;
      s.fan = s.duty > 0 || (s.fan && active);
      const sign = s.mode === 'COOL' ? -1 : 1;
      s.seat = s.seat.map(t => t + (sign * s.duty / 700 * 0.08 + (s.air + 2 - t) * 0.002 + (Math.random() - 0.5) * 0.01) * dt * 5);
      s.hx = s.hx.map(t => t + ((s.mode === 'COOL' ? s.duty / 700 * 25 : 0) + s.air + 3 - t) * 0.02 * dt * 5);
      BOARDS.C.tele = { sim: true, mode: s.mode, seat: s.seat, seatAvg: avg, hx: s.hx, air: s.air, rh: s.rh, dew,
        target, duty: s.duty, dutyMax: 1023, scale: 1, fan: s.fan, batt: true, dewLatch: false, heatLatch: false, dirWait: false, fault: '' };
      renderBoard('C');
    }
  },
};

// ═══════════ 운전 모드 / 자동 추적 ═══════════
let opMode = 'manual', lastAuto = { az: NaN, tilt: NaN, night: false };
function setOpMode(m) {
  opMode = m;
  $('manual').classList.toggle('selected', m === 'manual');
  $('auto').classList.toggle('selected', m === 'auto');
  $('state').textContent = m === 'auto' ? '자동 추적' : '수동 대기';
  $('stateNote').textContent = m === 'auto' ? `${CFG.autoPeriodMs / 1000}초마다 태양 위치로 이동` : '버튼 1회 = 설정한 각도만큼 이동';
  lastAuto = { az: NaN, tilt: NaN, night: false };
  if (m === 'auto') autoStep(true);
}
function targets(sun) {
  return { az: sun.az, tilt: clamp(CFG.tiltFromElevation(sun.el), CFG.zMin, CFG.zMax) };
}
function autoStep(force = false) {
  if (opMode !== 'auto') return;
  const sun = sunPosition(simNow(), CFG.lat, CFG.lon);
  if (sun.el <= 0) {
    if (!lastAuto.night) { log('해가 진 상태 → 틸트를 최저로 두고 대기', 'info', 'AUTO'); send('B', { cmd: 'z_goto', deg: CFG.zMin }, true); }
    lastAuto.night = true; return;
  }
  lastAuto.night = false;
  const t = targets(sun);
  if (force || !(Math.abs(wrap180(t.az - lastAuto.az)) < CFG.autoMinMoveDeg)) {
    send('B', { cmd: 'x_goto', az: +t.az.toFixed(1) }, !force); lastAuto.az = t.az;
  }
  if (force || !(Math.abs(t.tilt - lastAuto.tilt) < CFG.autoMinMoveDeg)) {
    send('B', { cmd: 'z_goto', deg: +t.tilt.toFixed(1) }, !force); lastAuto.tilt = t.tilt;
  }
}

// ═══════════ 그리기 ═══════════
const SKY = { x0: 40, x1: 580, y0: 230, y1: 20, az0: 45, az1: 315 };
const skyX = az => SKY.x0 + (clamp(az, SKY.az0, SKY.az1) - SKY.az0) / (SKY.az1 - SKY.az0) * (SKY.x1 - SKY.x0);
const skyY = el => SKY.y0 - clamp(el, -5, 90) / 90 * (SKY.y0 - SKY.y1);
let skyDayKey = '';
function drawSkyBase(date) {
  const p = kstParts(date), key = `${p.year}-${p.month}-${p.day}`;
  if (key === skyDayKey) return;
  skyDayKey = key;
  const midnight = new Date(`${key}T00:00:00+09:00`).getTime();
  const pts = [];
  for (let m = 0; m <= 1440; m += 5) {
    const s = sunPosition(new Date(midnight + m * 60000), CFG.lat, CFG.lon);
    if (s.el > -2 && s.az > SKY.az0 && s.az < SKY.az1) pts.push(`${skyX(s.az).toFixed(1)},${skyY(s.el).toFixed(1)}`);
  }
  let g = '';
  for (const el of [30, 60]) g += `<line class="grid" x1="${SKY.x0}" x2="${SKY.x1}" y1="${skyY(el)}" y2="${skyY(el)}"/><text class="tick" x="${SKY.x0 - 6}" y="${skyY(el) + 4}" text-anchor="end">${el}°</text>`;
  for (const [az, n] of [[90, '동 E'], [135, 'SE'], [180, '남 S'], [225, 'SW'], [270, '서 W']])
    g += `<line class="grid" x1="${skyX(az)}" x2="${skyX(az)}" y1="${SKY.y1}" y2="${SKY.y0}"/><text class="tick" x="${skyX(az)}" y="${SKY.y0 + 20}" text-anchor="middle">${n}</text>`;
  $('skySvg').innerHTML = `${g}
    <line class="horizon" x1="${SKY.x0}" x2="${SKY.x1}" y1="${SKY.y0}" y2="${SKY.y0}"/>
    <text class="tick" x="${SKY.x1}" y="${SKY.y0 - 6}" text-anchor="end">지평선</text>
    <polyline class="path" points="${pts.join(' ')}"/>
    <line id="skyShade" class="shade-line" y1="${SKY.y1}" y2="${SKY.y0}"/>
    <g id="skySun"><circle r="22" class="sun-halo"/><circle r="11" class="sun-dot"/></g>
    <text id="skySunLbl" class="sun-lbl" text-anchor="middle"></text>`;
}
function drawSky(date, sun) {
  drawSkyBase(date);
  const g = $('skySun'), x = skyX(sun.az), y = skyY(sun.el);
  g.setAttribute('transform', `translate(${x},${y})`);
  g.style.opacity = sun.el > 0 ? 1 : 0.25;
  const l = $('skySunLbl'); l.setAttribute('x', x); l.setAttribute('y', y - 28);
  l.textContent = `${fmt(sun.az)}° / ${fmt(sun.el)}°`;
}
function drawCompass(sun, shadeAz) {
  const ray = sun.el > 0 ? 95 : 0;
  const lab = [['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([t, a]) =>
    `<text class="cmp-lbl" x="${108 * Math.sin(a * RAD)}" y="${-108 * Math.cos(a * RAD) + 4}" text-anchor="middle">${t}</text>`).join('');
  $('compassSvg').innerHTML = `
    <circle r="95" class="ring"/><circle r="60" class="ring faint"/>${lab}
    <g transform="rotate(${sun.az})"><line class="sun-ray" y1="0" y2="${-ray}"/><circle cy="${-ray}" r="${ray ? 9 : 0}" class="sun-dot"/></g>
    ${ok(shadeAz) ? `<g transform="rotate(${shadeAz})"><rect class="panel" x="-46" y="-5" width="92" height="10" rx="3"/><path class="panel-arrow" d="M0,-8 L0,-40 M-7,-31 L0,-41 L7,-31"/></g>` : ''}
    <circle r="4" class="pivot"/>`;
}
function drawTilt(sun, tilt, tiltTgt) {
  const cx = 130, cy = 140, L = 80, el = clamp(sun.el, 0, 90);
  const pt = (a, r) => [cx + r * Math.cos(a * RAD), cy - r * Math.sin(a * RAD)];
  // 태양은 오른쪽. 판은 태양 반대쪽으로 tilt만큼 들려 있어야 법선이 태양을 향한다.
  const p1 = pt(180 - tilt, L / 2), p2 = pt(-tilt, L / 2);
  const tg1 = pt(180 - tiltTgt, L / 2), tg2 = pt(-tiltTgt, L / 2);
  const s = pt(el, 120);
  $('tiltSvg').innerHTML = `
    <line class="horizon" x1="10" x2="250" y1="${cy}" y2="${cy}"/>
    ${sun.el > 0 ? `<line class="sun-ray" x1="${cx}" y1="${cy}" x2="${s[0]}" y2="${s[1]}"/><circle class="sun-dot" cx="${s[0]}" cy="${s[1]}" r="8"/>` : ''}
    ${ok(tiltTgt) ? `<line class="panel-ghost" x1="${tg1[0]}" y1="${tg1[1]}" x2="${tg2[0]}" y2="${tg2[1]}"/>` : ''}
    ${ok(tilt) ? `<line class="panel-side" x1="${p1[0]}" y1="${p1[1]}" x2="${p2[0]}" y2="${p2[1]}"/>` : ''}
    <circle class="pivot" cx="${cx}" cy="${cy}" r="4"/>
    <text class="tick" x="14" y="${cy + 20}">틸트 ${fmt(tilt)}° · 고도 ${fmt(sun.el)}°</text>`;
}

function renderHero() {
  const now = simNow(), sun = sunPosition(now, CFG.lat, CFG.lon), t = targets(sun);
  const p = kstParts(now);
  $('clock').textContent = `${p.hour}:${p.minute}:${p.second}`;
  $('date').textContent = `${p.year}. ${p.month}. ${p.day}`;
  $('timeBadge').textContent = timeCtl.live && timeCtl.speed === 1 ? '실시간' : `시연 시각 · ${timeCtl.speed}×`;
  $('timeBadge').classList.toggle('demo', !(timeCtl.live && timeCtl.speed === 1));
  $('az').textContent = fmt(sun.az); $('el').textContent = fmt(sun.el);
  $('direction').textContent = `${dirName(sun.az)}쪽`;
  $('daylight').textContent = sun.el > 0 ? '주간 · 추적 가능' : sun.el > -6 ? '박명' : '야간';
  $('targetAz').textContent = sun.el > 0 ? `${fmt(t.az)}°` : '--°';
  $('targetEl').textContent = sun.el > 0 ? `${fmt(t.tilt)}°` : `${CFG.zMin}° (대기)`;

  const bt = BOARDS.B.tele;
  const shAz = bt?.x?.az, shTilt = bt?.z?.deg;
  $('shadeAz').textContent = fmt(shAz); $('shadeTilt').textContent = fmt(shTilt);
  $('shadeSrc').textContent = BOARDS.B.link ? 'ESP32-B 실측' : 'SIM';
  $('shadeSrc').classList.toggle('live', !!BOARDS.B.link);
  $('shadeAzErr').textContent = sun.el > 0 && ok(shAz) ? `태양과 차이 ${fmt(wrap180(t.az - shAz))}°` : '태양 없음';
  $('shadeTiltErr').textContent = `추정값 · 목표 ${sun.el > 0 ? fmt(t.tilt) : CFG.zMin}°`;
  drawSky(now, sun);
  const sl = $('skyShade');
  if (sl && ok(shAz)) { sl.setAttribute('x1', skyX(shAz)); sl.setAttribute('x2', skyX(shAz)); }
  drawCompass(sun, shAz);
  drawTilt(sun, shTilt, sun.el > 0 ? t.tilt : NaN);
}

const srcLabel = id => BOARDS[id].link ? `LIVE · ${BOARDS[id].link.kind}` : 'SIM';
function renderBoard(id) {
  const m = BOARDS[id].tele;
  if (!m) return;
  if (id === 'B') {
    $('xNow').textContent = `${fmt(m.x?.az)}°${m.x?.moving ? ' → ' + fmt(m.x.tgt) + '°' : ''}`;
    $('zNow').textContent = `${fmt(m.z?.deg)}°${m.z?.moving ? ' → ' + fmt(m.z.tgt) + '°' : ''}`;
    const lux = m.lux || [], mx = Math.max(1, ...lux.filter(ok));
    ['n', 'e', 's', 'w'].forEach((k, i) => {
      $(k).textContent = ok(lux[i]) ? Math.round(lux[i]).toLocaleString() : '오류';
      $(`bar-${k}`).style.width = ok(lux[i]) ? `${lux[i] / mx * 100}%` : '0%';
    });
    const best = lux.reduce((bi, v, i) => ok(v) && (!ok(lux[bi]) || v > lux[bi]) ? i : bi, 0);
    $('luxNote').textContent = ok(lux[best]) ? `가장 밝은 방향: ${['북', '동', '남', '서'][best]}` : '센서 응답 없음';
    $('luxSrc').textContent = srcLabel('B');
  }
  if (id === 'A') {
    const run = { open: '펼치는 중', close: '접는 중', stop: '정지' };
    (m.r || []).forEach((r, i) => {
      $(`enc${i + 1}`).textContent = r.enc ?? '--';
      $(`r${i + 1}pct`).textContent = ok(r.pct) ? `${Math.round(r.pct)}%` : '--';
      $(`r${i + 1}run`).textContent = run[r.run] || r.run;
    });
    $('wind').textContent = `${fmt(m.wind)} m/s`;
    $('windNote').textContent = ok(m.wind) ? (BOARDS.A.link ? 'A3144 실측' : '예시값') : '미연결';
    $('aSrc').textContent = srcLabel('A');
  }
  if (id === 'C') {
    const names = { COOL: '냉방', HEAT: '난방', OFF: '끔', FAULT: '고장' };
    $('cMode').textContent = names[m.mode] || m.mode;
    $('cMode').className = `board-chip ${m.mode === 'COOL' ? 'cool' : m.mode === 'HEAT' ? 'warm' : m.mode === 'FAULT' ? 'fault' : ''}`;
    document.querySelectorAll('[data-seat]').forEach(b => b.classList.toggle('selected', b.dataset.seat === m.mode));
    $('seatAvg').textContent = fmt(m.seatAvg);
    $('seatTarget').textContent = fmt(m.target);
    $('tecPct').textContent = ok(m.duty) ? Math.round(m.duty / (m.dutyMax || 1023) * 100) : '--';
    $('fan').textContent = m.fan ? 'ON' : 'OFF';
    $('seat3').textContent = (m.seat || []).map(v => fmt(v)).join(' · ');
    $('hx2').textContent = (m.hx || []).map(v => fmt(v)).join(' · ');
    $('airRh').textContent = `${fmt(m.air)}° · ${fmt(m.rh, 0)}%`;
    $('dew').textContent = fmt(m.dew);
    const gx = v => `${clamp((v - 10) / 40 * 100, 0, 100)}%`;
    $('gaugeFill').style.width = ok(m.seatAvg) ? gx(m.seatAvg) : '0';
    $('gaugeFill').className = m.mode === 'COOL' ? 'cool' : m.mode === 'HEAT' ? 'warm' : '';
    $('gaugeTarget').style.display = ok(m.target) ? '' : 'none'; if (ok(m.target)) $('gaugeTarget').style.left = gx(m.target);
    $('gaugeDew').style.display = ok(m.dew) ? '' : 'none'; if (ok(m.dew)) $('gaugeDew').style.left = gx(m.dew);
    const f = [];
    if (m.fault) f.push(['fault', `고장: ${m.fault}`]);
    if (m.batt === false) f.push(['fault', '배터리 감시: 부하 차단']);
    if (m.dewLatch) f.push(['warn', '결로 방지로 냉방 일시 정지']);
    if (m.heatLatch) f.push(['warn', '좌판 38°C 도달 · 난방 차단']);
    if (m.dirWait) f.push(['info', '극성 전환 대기 (10초)']);
    if (ok(m.scale) && m.scale < 1) f.push(['warn', `방열부 과열 · 출력 ${Math.round(m.scale * 100)}%로 제한`]);
    if (m.state) f.push(['info', `세부 상태: ${m.state}`]);           // 추후 FSR 단계(예냉/유지 등)
    if ('seated' in m) f.push(['info', m.seated ? '착석 감지' : '미착석']);
    if (!f.length) f.push(['ok', '정상']);
    $('cFlags').innerHTML = f.map(([k, t]) => `<span class="flag ${k}">${t}</span>`).join('');
    $('cSrc').textContent = srcLabel('C');
  }
}

function renderPills() {
  const now = Date.now();
  for (const [id, b] of Object.entries(BOARDS)) {
    const el = $(`pill-${id}`);
    let cls = 'sim', txt = `${b.name} · SIM`;
    if (b.link) {
      const fresh = now - b.seen < CFG.staleMs;
      cls = fresh ? 'live' : 'stale';
      txt = `${b.name} · ${fresh ? b.link.kind : '응답 없음'}`;
    }
    el.className = `pill ${cls}`;
    el.innerHTML = `<i></i> ${txt}`;
  }
}

// ═══════════ 버튼 ═══════════
let jogStep = 5;
document.querySelectorAll('#jogStep button').forEach(b => b.onclick = () => {
  jogStep = +b.dataset.v;
  document.querySelectorAll('#jogStep button').forEach(x => x.classList.toggle('selected', x === b));
});
const CMDS = {
  X_LEFT:   () => send('B', { cmd: 'x_jog', deg: -jogStep }),
  X_RIGHT:  () => send('B', { cmd: 'x_jog', deg: +jogStep }),
  Z_UP:     () => send('B', { cmd: 'z_jog', deg: +jogStep }),
  Z_DOWN:   () => send('B', { cmd: 'z_jog', deg: -jogStep }),
  R1_OPEN:  () => send('A', { cmd: 'roller', n: 1, dir: 'open', ms: CFG.rollerJogMs }),
  R1_CLOSE: () => send('A', { cmd: 'roller', n: 1, dir: 'close', ms: CFG.rollerJogMs }),
  R2_OPEN:  () => send('A', { cmd: 'roller', n: 2, dir: 'open', ms: CFG.rollerJogMs }),
  R2_CLOSE: () => send('A', { cmd: 'roller', n: 2, dir: 'close', ms: CFG.rollerJogMs }),
};
document.querySelectorAll('[data-cmd]').forEach(b => b.onclick = () => {
  if (opMode === 'auto' && b.dataset.cmd[0] !== 'R') { setOpMode('manual'); log('수동 조작 → 자동 추적 해제', 'info', 'AUTO'); }
  CMDS[b.dataset.cmd]();
  b.classList.add('pulse'); setTimeout(() => b.classList.remove('pulse'), 300);
});
const numIn = id => { const v = parseFloat($(id).value); return ok(v) ? v : null; };
$('btnGotoAz').onclick = () => { const v = numIn('gotoAz'); if (v !== null) { setOpMode('manual'); send('B', { cmd: 'x_goto', az: wrap360(v) }); } };
$('btnGotoTilt').onclick = () => { const v = numIn('gotoTilt'); if (v !== null) { setOpMode('manual'); send('B', { cmd: 'z_goto', deg: clamp(v, CFG.zMin, CFG.zMax) }); } };
$('btnZeroAz').onclick = () => { const v = numIn('zeroAz'); if (v !== null) send('B', { cmd: 'x_zero', az: wrap360(v) }); };
$('btnZeroTilt').onclick = () => { const v = numIn('zeroTilt'); if (v !== null) send('B', { cmd: 'z_zero', deg: v }); };
document.querySelectorAll('[data-seat]').forEach(b => b.onclick = () => send('C', { cmd: 'mode', value: b.dataset.seat }));
$('btnFaultReset').onclick = () => send('C', { cmd: 'fault_reset' });

$('manual').onclick = () => setOpMode('manual');
$('auto').onclick = () => setOpMode('auto');
$('stop').onclick = () => {
  setOpMode('manual');
  for (const id of ['B', 'A', 'C']) send(id, { cmd: 'stop' });
  log('전체 정지 명령', 'err', 'SYS');
};
$('clear').onclick = () => { $('logs').innerHTML = ''; };

// 시각
const toLocalInput = d => { const p = kstParts(d); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
$('simTime').value = toLocalInput(new Date());
$('simTime').onchange = e => {
  if (!e.target.value) return;
  setSimTime(new Date(`${e.target.value}:00+09:00`).getTime());
  log(`시연 시각 → ${e.target.value.replace('T', ' ')}`, 'info', 'TIME');
  lastAuto = { az: NaN, tilt: NaN, night: false }; autoStep(true);
};
document.querySelectorAll('[data-speed]').forEach(b => b.onclick = () => {
  setSimTime(simNow().getTime(), +b.dataset.speed);
  document.querySelectorAll('[data-speed]').forEach(x => x.classList.toggle('selected', x === b));
});
$('btnLive').onclick = () => {
  Object.assign(timeCtl, { live: true, speed: 1 });
  document.querySelectorAll('[data-speed]').forEach(x => x.classList.toggle('selected', x.dataset.speed === '1'));
  $('simTime').value = toLocalInput(new Date());
  log('실시간으로 복귀', 'info', 'TIME');
};

// ═══════════ 주기 작업 ═══════════
let lastTick = performance.now();
setInterval(() => {
  const t = performance.now(), dt = (t - lastTick) / 1000; lastTick = t;
  SIM.tick(Math.min(dt, 1));
  renderHero();
}, 200);
setInterval(() => {
  for (const [id, b] of Object.entries(BOARDS)) if (b.link) send(id, { cmd: 'ping' }, true);
  renderPills();
}, CFG.pingMs);
setInterval(() => autoStep(false), CFG.autoPeriodMs);
window.addEventListener('beforeunload', () => { for (const id of ['B', 'A']) if (BOARDS[id].link) BOARDS[id].link.send({ cmd: 'stop' }); });

$('locLabel').textContent = `SEOUL · ${CFG.lat.toFixed(4)}° N / ${CFG.lon.toFixed(4)}° E`;
renderHero(); renderPills();
initSerial();
log('대시보드 시작 · 연결되지 않은 보드는 SIM으로 동작', 'info', 'SYS');

// 테스트용 노출
window.SmartShade = { sunPosition, BOARDS, send, CFG };
