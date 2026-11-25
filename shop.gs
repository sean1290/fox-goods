/* ═══════════════════════════════════════════════════════════════
 * 폭스패밀리 굿즈샵 — Google Apps Script 백엔드
 *
 * 주문은 이 스크립트가 붙어 있는 Google Sheet의 「주문」 탭에 저장됩니다.
 * 설정 방법은 README.md 를 보세요.
 * ═══════════════════════════════════════════════════════════════ */

/* ── 1. 가게 설정 (여기만 고치면 됩니다) ───────────────────────── */

var SHOP = {
  name: '폭스패밀리 굿즈샵',
  open: true,                        // false 로 바꾸면 주문 마감

  bank: {
    bankName: '○○은행',              // TODO: 은행 이름
    account:  '000-0000-0000-00',    // TODO: 계좌번호
    holder:   '홍길동'                // TODO: 예금주
  },

  // 주문 페이지와 주문 문자에 표시되는 예상 도착 시기
  eta: '주문 마감 후 약 2~3주',

  // 주문 페이지 상단 안내 문구 (비워두면 표시 안 함)
  notice: '주문 제작 상품이라 받기까지 시간이 걸려요. 입금이 확인된 주문만 제작에 들어갑니다.',

  // 도착 문자에 들어가는 수령 방법
  pickup: 'Fox Learning Center 데스크에서 받아가실 수 있어요.',

  // 한 연락처로 하루에 넣을 수 있는 최대 주문 수 (문자 남용 방지)
  maxOrdersPerPhonePerDay: 10
};

/* ── 2. 문자 내용 ─────────────────────────────────────────────── */

function confirmMessage(o) {
  return '[' + SHOP.name + '] 주문이 접수되었어요!\n\n' +
    '주문번호: ' + o.id + '\n' +
    '상품: ' + o.product + '\n' +
    '사이즈: ' + o.size + ' / 수량: ' + o.qty + '개\n' +
    '금액: ' + won(o.total) + '\n\n' +
    '■ 입금 계좌\n' +
    SHOP.bank.bankName + ' ' + SHOP.bank.account + ' (' + SHOP.bank.holder + ')\n' +
    '※ 입금자명은 주문자 이름(' + o.name + ')으로 해주세요.\n\n' +
    '■ 예상 도착: ' + SHOP.eta + '\n' +
    '(주문 제작 상품이라 시간이 걸려요)\n\n' +
    '상품이 도착하면 다시 문자로 알려드릴게요. 감사합니다!';
}

function paidMessage(o) {
  return '[' + SHOP.name + '] 입금이 확인되었어요!\n\n' +
    '주문번호: ' + o.id + '\n' +
    '상품: ' + o.product + ' (' + o.size + ') ' + o.qty + '개\n' +
    '금액: ' + won(o.total) + '\n\n' +
    '이제 제작을 시작해요.\n' +
    '■ 예상 도착: ' + SHOP.eta + '\n\n' +
    '상품이 도착하면 다시 문자로 알려드릴게요. 감사합니다!';
}

function arrivalMessage(o) {
  return '[' + SHOP.name + '] 주문하신 상품이 도착했어요!\n\n' +
    '주문번호: ' + o.id + '\n' +
    '상품: ' + o.product + ' (' + o.size + ') ' + o.qty + '개\n\n' +
    SHOP.pickup + '\n감사합니다!';
}

/* ═══════════════════════════════════════════════════════════════
 * 아래는 수정하지 않아도 됩니다.
 * ═══════════════════════════════════════════════════════════════ */

var SHEET_NAME = '주문';
var HEADERS = ['주문번호', '주문일시', '이름', '연락처', '상품ID', '상품', '사이즈', '수량',
               '단가', '금액', '입금확인', '주문문자', '도착문자', '도착문자일시', '상태', '입금문자'];
var COL = {}; HEADERS.forEach(function (h, i) { COL[h] = i; });

/* ── Web app 진입점 ─────────────────────────────────────────── */

function doGet(e) {
  var action = e && e.parameter && e.parameter.action;
  if (action === 'info') return out(publicInfo());
  return out({ status: 'ok', message: 'Fox shop running' });
}

function doPost(e) {
  try {
    var d = JSON.parse(e.postData.contents);
    switch (d.action) {
      case 'order':         return out(placeOrder(d));
      case 'adminList':     auth(d); return out({ status: 'ok', orders: listOrders(), info: publicInfo(), smsReady: smsReady() });
      case 'setPaid':       auth(d); return out(setPaid(d.id, d.paid));
      case 'resendPaid':    auth(d); return out(sendPaidSms(d.id));
      case 'setCancelled':  auth(d); return out(updateOrder(d.id, function (r) { r[COL['상태']] = d.cancelled ? '취소' : ''; }));
      case 'sendArrival':   auth(d); return out(sendArrival(d.id, d.markOnly));
      case 'resendConfirm': auth(d); return out(resendConfirm(d.id));
      default:              return out({ status: 'error', message: 'unknown action' });
    }
  } catch (err) {
    return out({ status: 'error', message: String(err.message || err) });
  }
}

function publicInfo() {
  return { status: 'ok', open: SHOP.open, bank: SHOP.bank, eta: SHOP.eta, notice: SHOP.notice };
}

/* ── 주문 접수 ───────────────────────────────────────────────── */

function placeOrder(d) {
  if (!SHOP.open) throw new Error('지금은 주문을 받지 않아요.');
  if (d.website) throw new Error('잘못된 요청입니다.');           // 스팸 방지용 숨은 칸

  var name  = String(d.name || '').trim().slice(0, 30);
  var phone = String(d.phone || '').replace(/\D/g, '');
  var qty   = parseInt(d.qty, 10);
  var price = parseInt(d.unitPrice, 10);
  if (!name) throw new Error('이름을 입력해 주세요.');
  if (!/^01[016789]\d{7,8}$/.test(phone)) throw new Error('휴대폰 번호를 확인해 주세요.');
  if (!d.productId || !d.productName || !d.size) throw new Error('상품과 사이즈를 골라 주세요.');
  if (!(qty >= 1 && qty <= 10)) throw new Error('수량을 확인해 주세요.');
  if (!(price > 0)) throw new Error('가격 정보가 올바르지 않아요.');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var o;
  try {
    var sheet = getSheet();
    var rows = sheet.getDataRange().getValues().slice(1);

    var today = Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd');
    var sameToday = rows.filter(function (r) {
      return String(r[COL['연락처']]).replace(/\D/g, '') === phone &&
             String(r[COL['주문일시']]).indexOf(today) === 0;
    }).length;
    if (sameToday >= SHOP.maxOrdersPerPhonePerDay) throw new Error('오늘 주문 가능한 횟수를 넘었어요. 센터에 문의해 주세요.');

    o = {
      id: 'FX' + Utilities.formatDate(new Date(), tz(), 'MMdd') + '-' + ('000' + nextSeq()).slice(-3),
      date: now(), name: name, phone: formatPhone(phone),
      productId: String(d.productId).slice(0, 40), product: String(d.productName).slice(0, 60),
      size: String(d.size).slice(0, 20), qty: qty, unitPrice: price, total: qty * price
    };
    sheet.appendRow([o.id, o.date, o.name, o.phone, o.productId, o.product, o.size, o.qty,
                     o.unitPrice, o.total, '', '', '', '', '']);
  } finally {
    lock.releaseLock();
  }

  var sms = sendSms(o.phone, confirmMessage(o));
  updateOrder(o.id, function (r) { r[COL['주문문자']] = sms.ok ? '발송 ' + now() : '실패: ' + sms.error; });

  return { status: 'ok', orderId: o.id, total: o.total, smsSent: sms.ok,
           bank: SHOP.bank, eta: SHOP.eta };
}

/* ── 관리자 기능 ─────────────────────────────────────────────── */

function auth(d) {
  var pw = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  if (!pw) throw new Error('ADMIN_PASSWORD가 설정되지 않았어요. (스크립트 속성)');
  if (String(d.password || '') !== pw) throw new Error('비밀번호가 틀렸어요.');
}

function listOrders() {
  var values = getSheet().getDataRange().getDisplayValues().slice(1);
  return values.filter(function (r) { return r[0]; }).map(rowToOrder);
}

function rowToOrder(r) {
  return {
    id: r[COL['주문번호']], date: String(r[COL['주문일시']]), name: r[COL['이름']],
    phone: String(r[COL['연락처']]), productId: r[COL['상품ID']],
    product: r[COL['상품']], size: String(r[COL['사이즈']]), qty: Number(String(r[COL['수량']]).replace(/\D/g, '')),
    unitPrice: Number(String(r[COL['단가']]).replace(/\D/g, '')), total: Number(String(r[COL['금액']]).replace(/\D/g, '')),
    paid: String(r[COL['입금확인']] || ''), confirmSms: String(r[COL['주문문자']] || ''),
    arrivalSms: String(r[COL['도착문자']] || ''), arrivalAt: String(r[COL['도착문자일시']] || ''),
    cancelled: r[COL['상태']] === '취소',
    paidSms: String(r[COL['입금문자']] || '')
  };
}

// 입금 확인: 처음 확인할 때 입금 완료 문자를 자동으로 보냄
function setPaid(id, paid) {
  var before = findOrder(id);
  var res = updateOrder(id, function (r) { r[COL['입금확인']] = paid ? now() : ''; });
  if (paid && !before.paid && !before.paidSms) res.sms = sendPaidSms(id);
  return res;
}

function sendPaidSms(id) {
  var o = findOrder(id);
  var text = paidMessage(o);
  var sms = sendSms(o.phone, text);
  var res = updateOrder(id, function (r) { r[COL['입금문자']] = sms.ok ? '발송 ' + now() : '실패: ' + sms.error; });
  return { status: 'ok', sent: sms.ok, error: sms.error || '', phone: o.phone, text: text, order: res.order };
}

function sendArrival(id, markOnly) {
  var o = findOrder(id);
  var text = arrivalMessage(o);
  // markOnly: 관리자가 휴대폰으로 직접 보낸 뒤 '보냄'으로만 표시
  var sms = markOnly ? { ok: true } : sendSms(o.phone, text);
  if (sms.ok) {
    updateOrder(id, function (r) { r[COL['도착문자']] = '발송완료'; r[COL['도착문자일시']] = now(); });
  }
  return { status: 'ok', sent: sms.ok, error: sms.error || '', phone: o.phone, text: text };
}

function resendConfirm(id) {
  var o = findOrder(id);
  var text = confirmMessage(o);
  var sms = sendSms(o.phone, text);
  updateOrder(id, function (r) { r[COL['주문문자']] = sms.ok ? '발송 ' + now() : '실패: ' + sms.error; });
  return { status: 'ok', sent: sms.ok, error: sms.error || '', phone: o.phone, text: text };
}

function findOrder(id) {
  var values = getSheet().getDataRange().getDisplayValues();
  for (var i = 1; i < values.length; i++) if (values[i][0] === id) return rowToOrder(values[i]);
  throw new Error('주문을 찾을 수 없어요: ' + id);
}

function updateOrder(id, mutate) {
  var sheet = getSheet();
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] === id) {
      var row = values[i].slice();
      while (row.length < HEADERS.length) row.push('');
      mutate(row);
      sheet.getRange(i + 1, 1, 1, HEADERS.length).setValues([row.slice(0, HEADERS.length)]);
      return { status: 'ok', order: rowToOrder(sheet.getRange(i + 1, 1, 1, HEADERS.length).getDisplayValues()[0]) };
    }
  }
  throw new Error('주문을 찾을 수 없어요: ' + id);
}

/* ── 문자 발송 (SOLAPI) ──────────────────────────────────────── */
// 스크립트 속성에 SOLAPI_API_KEY, SOLAPI_API_SECRET, SENDER_PHONE 을 넣으면 자동 발송됩니다.

function smsReady() {
  var p = PropertiesService.getScriptProperties();
  return !!(p.getProperty('SOLAPI_API_KEY') && p.getProperty('SOLAPI_API_SECRET') && p.getProperty('SENDER_PHONE'));
}

function sendSms(to, text) {
  var p = PropertiesService.getScriptProperties();
  var key = p.getProperty('SOLAPI_API_KEY'), secret = p.getProperty('SOLAPI_API_SECRET'),
      from = String(p.getProperty('SENDER_PHONE') || '').replace(/\D/g, '');
  if (!key || !secret || !from) return { ok: false, error: '문자 설정 안 됨' };

  var date = new Date().toISOString();
  var salt = Utilities.getUuid().replace(/-/g, '');
  var sig = Utilities.computeHmacSha256Signature(date + salt, secret)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');

  try {
    var res = UrlFetchApp.fetch('https://api.solapi.com/messages/v4/send', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'HMAC-SHA256 apiKey=' + key + ', date=' + date + ', salt=' + salt + ', signature=' + sig },
      payload: JSON.stringify({ message: { to: String(to).replace(/\D/g, ''), from: from, text: text, subject: SHOP.name } }),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code >= 200 && code < 300) return { ok: true };
    var body = {}; try { body = JSON.parse(res.getContentText()); } catch (e) {}
    return { ok: false, error: (body.errorMessage || body.statusMessage || ('HTTP ' + code)) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// Apps Script 편집기에서 실행해 보는 테스트: 내 번호로 문자 한 통 보내기
function testSms() {
  var me = PropertiesService.getScriptProperties().getProperty('SENDER_PHONE');
  Logger.log(JSON.stringify(sendSms(me, '[' + SHOP.name + '] 문자 발송 테스트입니다.')));
}

/* ── 공통 ───────────────────────────────────────────────────── */

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, sheet.getMaxRows(), HEADERS.length).setNumberFormat('@');   // 날짜·전화번호 자동변환 방지
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
      .setFontWeight('bold').setBackground('#FFF1E6');
    sheet.setFrozenRows(1);
  } else if (sheet.getLastColumn() < HEADERS.length) {
    // 예전 버전 시트에 새 칸(입금문자) 추가
    var n = HEADERS.length;
    sheet.getRange(1, 1, sheet.getMaxRows(), n).setNumberFormat('@');
    sheet.getRange(1, 1, 1, n).setValues([HEADERS]).setFontWeight('bold').setBackground('#FFF1E6');
  }
  return sheet;
}

function nextSeq() {
  var p = PropertiesService.getScriptProperties();
  var n = Number(p.getProperty('ORDER_SEQ') || 0) + 1;
  p.setProperty('ORDER_SEQ', String(n));
  return n;
}

function tz() { return Session.getScriptTimeZone() || 'Asia/Seoul'; }
function now() { return Utilities.formatDate(new Date(), tz(), 'yyyy-MM-dd HH:mm'); }
function won(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원'; }
function formatPhone(p) { return p.length === 11 ? p.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3') : p.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3'); }

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
