<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api, mailboxPath, mailboxFromSearch, emailHtmlDocument } from './api.js';

const tempMailboxes = ref(readSavedMailboxes());
const accountMailboxes = ref([]);
const user = ref(null);
const selected = ref(null);
const messages = ref([]);
const activeMessage = ref(null);
const notice = ref('');
const loading = ref(false);
const busy = ref(false);
const authOpen = ref(false);
const mailboxOpen = ref(false);
const mailboxName = ref('');
const mailboxMenu = ref(null);
const messageMenu = ref(null);
const authMode = ref('login');
const username = ref('');
const password = ref('');
const mobilePane = ref('mailboxes');
const sharedMailbox = mailboxFromSearch(location.search);
const sharedView = sharedMailbox !== null;
let poller;
let listRequest = 0;

const allMailboxes = computed(() => sharedView ? (selected.value ? [selected.value] : []) : [...accountMailboxes.value, ...tempMailboxes.value]);
const currentAddress = computed(() => selected.value?.address || '尚未选择邮箱');

function readSavedMailboxes() {
  try {
    const saved = JSON.parse(localStorage.getItem('temp-mailboxes') || '[]');
    return Array.isArray(saved) ? saved.filter(item => /^[a-z0-9]{5,24}@e-com\.cc$/.test(item?.address)).map(item => ({ kind: 'temp', id: item.address.split('@')[0], address: item.address })) : [];
  } catch { return []; }
}

function saveTempMailboxes() {
  localStorage.setItem('temp-mailboxes', JSON.stringify(tempMailboxes.value.map(({ address }) => ({ address }))));
}

function showError(error) { notice.value = error.message || '操作失败，请稍后重试'; }
function randomMailboxName() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  mailboxName.value = Array.from(crypto.getRandomValues(new Uint8Array(5)), byte => alphabet[byte % alphabet.length]).join('');
}
function showMailboxMenu(mailbox, event) {
  messageMenu.value = null;
  mailboxMenu.value = { mailbox, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 190)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 60)) };
}
function showMessageMenu(message, event) {
  mailboxMenu.value = null;
  messageMenu.value = { message, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 190)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 60)) };
}
function hiddenMessageIds(mailbox) {
  try {
    const ids = JSON.parse(localStorage.getItem(`hidden-messages:${mailbox.id}`) || '[]');
    return Array.isArray(ids) ? ids : [];
  } catch { return []; }
}
function selectMailboxFromClick(mailbox) {
  if (!window.getSelection()?.toString()) selectMailbox(mailbox);
}
function formatTime(value) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

async function selectMailbox(mailbox) {
  selected.value = mailbox;
  activeMessage.value = null;
  messages.value = [];
  mobilePane.value = 'messages';
  await refreshMessages();
}

async function refreshMessages(silent = false) {
  if (!selected.value) return;
  const mailbox = selected.value;
  const request = ++listRequest;
  if (!silent) loading.value = true;
  try {
    const rows = await api(mailboxPath(mailbox));
    if (request === listRequest && selected.value === mailbox) {
      const hidden = mailbox.kind === 'temp' || (mailbox.kind === 'public' && !accountMailboxes.value.some(item => item.id === mailbox.id)) ? hiddenMessageIds(mailbox) : [];
      messages.value = rows.filter(row => !hidden.includes(row.id));
    }
  } catch (error) {
    if (request === listRequest && !silent) showError(error);
  } finally {
    if (request === listRequest) loading.value = false;
  }
}

async function openMessage(message) {
  if (!selected.value) return;
  const mailbox = selected.value;
  activeMessage.value = { id: message.id, loading: true };
  mobilePane.value = 'detail';
  try {
    const detail = await api(`${mailboxPath(mailbox)}/${message.id}`);
    if (selected.value === mailbox && activeMessage.value?.id === message.id) {
      activeMessage.value = detail;
      const row = messages.value.find(item => item.id === message.id);
      if (row) row.isRead = 1;
    }
  } catch (error) {
    if (selected.value === mailbox) {
      activeMessage.value = null;
      showError(error);
    }
  }
}

async function createMailbox(kind, name = '') {
  busy.value = true;
  notice.value = '';
  try {
    const result = await api(`/${kind}-mailboxes`, { method: 'POST', ...(kind === 'account' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(name ? { name } : { random: true }) } : {}) });
    const mailbox = { kind, id: result.id || result.address.split('@')[0], address: result.address };
    if (kind === 'temp') {
      tempMailboxes.value.unshift(mailbox);
      saveTempMailboxes();
    } else {
      accountMailboxes.value.unshift(mailbox);
      mailboxOpen.value = false;
      mailboxName.value = '';
    }
    await selectMailbox(mailbox);
  } catch (error) { showError(error); }
  finally { busy.value = false; }
}

async function deleteMailbox(mailbox) {
  mailboxMenu.value = null;
  if (!confirm(mailbox.kind === 'account' ? `永久删除 ${mailbox.address} 及其所有邮件和附件？` : `从此浏览器移除 ${mailbox.address}？邮件仍可通过地址访问。`)) return;
  busy.value = true;
  try {
    if (mailbox.kind === 'account') {
      await api(`/account-mailboxes/${encodeURIComponent(mailbox.id)}`, { method: 'DELETE' });
      accountMailboxes.value = accountMailboxes.value.filter(item => item !== mailbox);
    } else {
      tempMailboxes.value = tempMailboxes.value.filter(item => item !== mailbox);
      saveTempMailboxes();
    }
    if (selected.value === mailbox) {
      selected.value = null;
      activeMessage.value = null;
      messages.value = [];
      listRequest++;
      const next = accountMailboxes.value[0] || tempMailboxes.value[0];
      if (next) await selectMailbox(next);
      else mobilePane.value = 'mailboxes';
    }
  } catch (error) { showError(error); }
  finally { busy.value = false; }
}

async function deleteMessage(message) {
  messageMenu.value = null;
  const mailbox = selected.value;
  if (!mailbox) return;
  const owned = mailbox.kind === 'account' || accountMailboxes.value.some(item => item.id === mailbox.id);
  if (!confirm(owned ? '永久删除这封邮件及其附件？' : '从此浏览器隐藏这封邮件？其他人仍可通过邮箱地址访问。')) return;
  busy.value = true;
  try {
    if (owned) await api(`${mailboxPath(mailbox)}/${message.id}`, { method: 'DELETE' });
    // shortcut: temporary mail has no verified owner, so deletion stays local until ownership exists.
    else localStorage.setItem(`hidden-messages:${mailbox.id}`, JSON.stringify([...new Set([...hiddenMessageIds(mailbox), message.id])]));
    if (selected.value === mailbox) {
      listRequest++;
      messages.value = messages.value.filter(item => item.id !== message.id);
      if (activeMessage.value?.id === message.id) {
        activeMessage.value = null;
        mobilePane.value = 'messages';
      }
    }
  } catch (error) { showError(error); }
  finally { busy.value = false; }
}

async function copyAddress() {
  if (!selected.value) return;
  try {
    await navigator.clipboard.writeText(selected.value.address);
    notice.value = '邮箱地址已复制';
  } catch { notice.value = '复制失败，请手动选择地址'; }
}

async function submitAuth() {
  busy.value = true;
  notice.value = '';
  try {
    const account = await api(authMode.value === 'login' ? '/login' : '/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value, password: password.value })
    });
    user.value = account;
    const me = await api('/me');
    accountMailboxes.value = me.mailboxes.map(item => ({ ...item, kind: 'account' }));
    authOpen.value = false;
    password.value = '';
    if (sharedView && selected.value) await refreshMessages();
    else if (!sharedView && accountMailboxes.value.length) await selectMailbox(accountMailboxes.value[0]);
    else if (!selected.value) mobilePane.value = 'mailboxes';
  } catch (error) { showError(error); }
  finally { busy.value = false; }
}

async function logout() {
  busy.value = true;
  try {
    await api('/logout', { method: 'POST' });
    user.value = null;
    accountMailboxes.value = [];
    if (sharedView) {
      activeMessage.value = null;
      messages.value = [];
      listRequest++;
    }
    if (selected.value?.kind === 'account') {
      selected.value = null;
      activeMessage.value = null;
      messages.value = [];
      if (tempMailboxes.value.length) await selectMailbox(tempMailboxes.value[0]);
      else await createMailbox('temp');
    }
    notice.value = '已退出登录';
  } catch (error) { showError(error); }
  finally { busy.value = false; }
}

onMounted(async () => {
  document.addEventListener('click', closeMailboxMenu);
  try {
    const me = await api('/me');
    user.value = { id: me.id, username: me.username };
    accountMailboxes.value = me.mailboxes.map(item => ({ ...item, kind: 'account' }));
  } catch (error) {
    if (error.message !== 'Unauthorized') showError(error);
  }
  if (sharedView) {
    if (sharedMailbox) await selectMailbox(sharedMailbox);
    else notice.value = '邮箱地址格式无效';
  }
  else if (accountMailboxes.value.length) await selectMailbox(accountMailboxes.value[0]);
  else if (tempMailboxes.value.length) await selectMailbox(tempMailboxes.value[0]);
  else if (!user.value) await createMailbox('temp');
  poller = setInterval(() => { if (!document.hidden) refreshMessages(true); }, 8000);
});
function closeMailboxMenu() { mailboxMenu.value = null; messageMenu.value = null; }
onUnmounted(() => { clearInterval(poller); document.removeEventListener('click', closeMailboxMenu); });
</script>

<template>
  <div class="app-shell">
    <header class="site-header">
      <div class="header-inner">
        <a class="brand" href="/mail/" aria-label="e-com.cc 邮箱首页">
          <span class="brand-mark"><img src="/logo.svg" alt="" /></span>
          <span class="brand-text"><span>e-com<span>.cc</span></span><small>轻量收件箱</small></span>
        </a>
        <nav class="header-nav" aria-label="页面导航"><a href="#mailboxes">我的邮箱</a><a href="#inbox">收件箱</a></nav>
        <div class="header-right">
          <span v-if="user" class="user-chip">{{ user.username }}</span>
          <button class="header-button" :disabled="busy" @click="user ? logout() : (authOpen = true)">
            {{ user ? '退出登录' : '登录获取长效邮箱' }}
          </button>
        </div>
      </div>
    </header>

    <main class="main-area">
      <div class="hero-area">
      <section class="intro">
        <div>
          <p class="eyebrow"><span class="live-dot"></span> 简单、安全感更清晰的收信体验</p>
          <h1>临时邮箱，<em>即开即用。</em></h1>
          <p class="intro-copy">长效邮箱，跨设备使用，邮件保留 30 天。</p>
        </div>
      </section>

      <section class="address-card" aria-label="当前邮箱">
        <div class="address-main">
          <span class="field-label">当前邮箱地址 <span v-if="selected" class="kind-tag">{{ selected.kind === 'public' ? '公开邮箱' : selected.kind === 'account' ? '长效邮箱' : '临时邮箱' }}</span></span>
          <div class="address-line">
            <strong :title="currentAddress">{{ currentAddress }}</strong>
            <button class="copy-button" :disabled="!selected" @click="copyAddress">复制地址</button>
          </div>
          <p class="address-hint">复制地址并用于收信，新邮件会自动显示在下方。</p>
        </div>
      </section>
      </div>
      <div v-if="!sharedView" class="action-strip">
        <div class="address-actions">
          <button class="button button-secondary" :disabled="busy" @click="createMailbox('temp')">获取临时邮箱</button>
          <button v-if="user" class="button button-primary" :disabled="busy" @click="mailboxOpen = true">获取长效邮箱</button>
          <button v-else class="button button-primary" @click="authOpen = true">登录获取长效邮箱</button>
        </div>
      </div>

      <div class="content-area">
      <p v-if="notice" class="notice" role="status"><span>{{ notice }}</span><button aria-label="关闭提示" @click="notice = ''">×</button></p>

      <div class="mobile-nav" aria-label="收件箱导航">
        <button :class="{ active: mobilePane === 'mailboxes' }" @click="mobilePane = 'mailboxes'">邮箱</button>
        <button :class="{ active: mobilePane === 'messages' }" :disabled="!selected" @click="mobilePane = 'messages'">邮件</button>
        <button :class="{ active: mobilePane === 'detail' }" :disabled="!activeMessage" @click="mobilePane = 'detail'">详情</button>
      </div>

      <section id="inbox" class="workspace" aria-label="收件箱工作区">
        <aside id="mailboxes" class="mailboxes-pane" :class="{ 'mobile-active': mobilePane === 'mailboxes' }">
          <div class="pane-heading"><h2>我的邮箱 <span>{{ allMailboxes.length }}</span></h2></div>
          <div class="mailbox-scroll">
            <div v-if="sharedView && selected" class="mailbox-group">
              <p class="group-label">当前邮箱</p>
              <div class="mailbox-row selected" role="button" tabindex="0" @click="selectMailboxFromClick(selected)" @keydown.enter="selectMailbox(selected)" @keydown.space.prevent="selectMailbox(selected)"><span class="mailbox-icon" aria-hidden="true">@</span><span class="mailbox-name">{{ selected.address }}</span></div>
            </div>
            <div v-if="!sharedView && accountMailboxes.length" class="mailbox-group">
              <p class="group-label">长效邮箱</p>
              <div v-for="mailbox in accountMailboxes" :key="`account-${mailbox.id}`" class="mailbox-row" :class="{ selected: selected === mailbox }" role="button" tabindex="0" @click="selectMailboxFromClick(mailbox)" @keydown.enter="selectMailbox(mailbox)" @keydown.space.prevent="selectMailbox(mailbox)" @contextmenu.prevent="showMailboxMenu(mailbox, $event)">
                <span class="mailbox-icon account-icon" aria-hidden="true">✦</span><span class="mailbox-name">{{ mailbox.address }}</span>
              </div>
            </div>
            <div v-if="!sharedView" class="mailbox-group">
              <p class="group-label">临时邮箱</p>
              <div v-for="mailbox in tempMailboxes" :key="`temp-${mailbox.id}`" class="mailbox-row" :class="{ selected: selected === mailbox }" role="button" tabindex="0" @click="selectMailboxFromClick(mailbox)" @keydown.enter="selectMailbox(mailbox)" @keydown.space.prevent="selectMailbox(mailbox)" @contextmenu.prevent="showMailboxMenu(mailbox, $event)">
                <span class="mailbox-icon" aria-hidden="true">@</span><span class="mailbox-name">{{ mailbox.address }}</span>
              </div>
              <p v-if="!tempMailboxes.length" class="sidebar-empty">还没有临时邮箱</p>
            </div>
          </div>
          <div class="sidebar-footer">临时邮箱公开可见，请勿用于私人信息。</div>
        </aside>

        <section class="messages-pane" :class="{ 'mobile-active': mobilePane === 'messages' }" aria-label="邮件列表">
          <div class="pane-heading list-heading">
            <h2>收件箱 <span>{{ messages.length }}</span></h2>
            <button class="refresh-button" :disabled="!selected || loading" aria-label="刷新邮件" title="刷新邮件" @click="refreshMessages()">↻</button>
          </div>
          <div class="messages-scroll">
            <p v-if="loading && !messages.length" class="empty-small">正在加载邮件…</p>
            <div v-else-if="!messages.length" class="empty-state">
              <div class="empty-illustration" aria-hidden="true">✉</div>
              <h3>{{ selected ? '暂时没有新邮件' : '先选择一个邮箱' }}</h3>
              <p>{{ selected ? '发送邮件到上方地址，新邮件会自动出现在这里。' : '选择左侧邮箱，查看收到的邮件。' }}</p>
            </div>
            <button v-for="message in messages" :key="message.id" class="message-row" :class="{ active: activeMessage?.id === message.id, unread: !message.isRead }" @click="openMessage(message)" @contextmenu.prevent="showMessageMenu(message, $event)">
              <span class="message-top"><strong>{{ message.subject || '(无主题)' }}</strong><time>{{ formatTime(message.receivedAt) }}</time></span>
              <span class="message-sender">{{ message.sender || '未知发件人' }}</span>
              <span v-if="message.spamSuspected" class="spam-label">疑似垃圾邮件</span>
            </button>
          </div>
          <div class="pane-footer">每 8 秒自动检查新邮件</div>
        </section>

        <article class="detail-pane" :class="{ 'mobile-active': mobilePane === 'detail' }" aria-label="邮件详情">
          <template v-if="activeMessage?.loading"><div class="detail-loading">正在打开邮件…</div></template>
          <template v-else-if="activeMessage">
            <div class="detail-header"><p class="pane-kicker">MESSAGE DETAIL</p><h2>{{ activeMessage.subject || '(无主题)' }}</h2><div class="detail-meta"><span>发件人</span><strong>{{ activeMessage.sender }}</strong></div><div class="detail-meta"><span>收件人</span><strong>{{ activeMessage.address }}</strong></div><div class="detail-meta"><span>时间</span><strong>{{ formatTime(activeMessage.receivedAt) }}</strong></div></div>
            <div class="detail-body"><iframe v-if="activeMessage.html" title="邮件 HTML 正文" sandbox="" referrerpolicy="no-referrer" :srcdoc="emailHtmlDocument(activeMessage.html)"></iframe><pre v-else>{{ activeMessage.text || '（这封邮件没有文本正文）' }}</pre></div>
            <div v-if="activeMessage.attachments?.length" class="attachments"><h3>附件 <span>{{ activeMessage.attachments.length }}</span></h3><a v-for="file in activeMessage.attachments" :key="file.id" :href="`/api${mailboxPath(selected)}/${activeMessage.id}/attachments/${file.id}`"><span>↓</span><span>{{ file.filename }}</span><small>{{ Math.ceil(file.size / 1024) }} KB</small></a></div>
          </template>
          <div v-else class="detail-empty"><div class="detail-empty-icon" aria-hidden="true">✉</div><h3>选择一封邮件</h3><p>邮件内容将在这里显示</p></div>
        </article>
      </section>
      <p class="page-disclaimer">临时邮箱的邮件对知道地址的人公开。请勿用它接收验证码、密码重置邮件或其他私人信息。</p>
      </div>
    </main>

    <div v-if="mailboxMenu" class="mailbox-menu" role="menu" :style="{ left: `${mailboxMenu.x}px`, top: `${mailboxMenu.y}px` }" @click.stop><button role="menuitem" :disabled="busy" @click="deleteMailbox(mailboxMenu.mailbox)">删除</button></div>
    <div v-if="messageMenu" class="mailbox-menu" role="menu" :style="{ left: `${messageMenu.x}px`, top: `${messageMenu.y}px` }" @click.stop><button role="menuitem" :disabled="busy" @click="deleteMessage(messageMenu.message)">删除</button></div>

    <div v-if="authOpen" class="modal-backdrop" @click.self="authOpen = false">
      <section class="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <button class="modal-close" aria-label="关闭" @click="authOpen = false">×</button>
        <span class="brand-mark modal-icon"><img src="/logo.svg" alt="" /></span>
        <h2 id="auth-title">{{ authMode === 'login' ? '欢迎回来' : '创建你的账号' }}</h2>
        <p v-if="notice" class="modal-error" role="alert">{{ notice }}</p>
        <form @submit.prevent="submitAuth">
          <label for="username">用户名</label>
          <input id="username" v-model="username" required minlength="1" maxlength="32" pattern="[a-z0-9_]+" autocomplete="username" placeholder="至少 1 位，小写字母、数字或下划线" />
          <label for="password">密码</label>
          <input id="password" v-model="password" type="password" required minlength="6" maxlength="128" :autocomplete="authMode === 'login' ? 'current-password' : 'new-password'" placeholder="至少 6 位" />
          <button class="button button-primary modal-submit" :disabled="busy" type="submit">{{ busy ? '请稍候…' : (authMode === 'login' ? '登录' : '注册并登录') }}</button>
        </form>
        <button class="mode-switch" @click="authMode = authMode === 'login' ? 'register' : 'login'">{{ authMode === 'login' ? '没有账号？立即注册' : '已有账号？返回登录' }}</button>
      </section>
    </div>
    <div v-if="mailboxOpen" class="modal-backdrop" @click.self="mailboxOpen = false">
      <section class="auth-modal" role="dialog" aria-modal="true" aria-labelledby="mailbox-title">
        <button class="modal-close" aria-label="关闭" @click="mailboxOpen = false">×</button>
        <h2 id="mailbox-title">获取长效邮箱</h2>
        <p v-if="notice" class="modal-error" role="alert">{{ notice }}</p>
        <form @submit.prevent="createMailbox('account', mailboxName)">
          <label for="mailbox-name">邮箱名</label>
          <input id="mailbox-name" v-model="mailboxName" required maxlength="128" pattern="[a-z0-9_][a-z0-9_.-]*" placeholder="小写字母、数字、下划线、点或短横线" />
          <p>@e-com.cc</p>
          <button class="button button-primary modal-submit" :disabled="busy" type="submit">创建邮箱</button>
          <button class="button button-secondary modal-submit" :disabled="busy" type="button" @click="randomMailboxName">随机生成名称</button>
        </form>
      </section>
    </div>
  </div>
</template>
