<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { authFlash, useAuth } from '../lib/useAuth'
import { isGuest, loginViaGithub, loginViaGoogle, loginViaMail } from '../data/store'
import { vDialog } from '../lib/useDialog'
import { X as IconX } from 'lucide-vue-next'

/**
 * 登录弹层，版式照 reactbits auth-2 那一块：左半张品牌图（照片铺底 + 左上角品牌块 + 左下角大标题），
 * 右半表单（大号标题、OAuth 按钮、「或者」分隔、两个输入框、一颗实底主按钮、底下小字行）。
 * 尺寸与圆角照它渲染出来的读数抄：控件高 48、圆角 16、右栏内边距 48、标题 32/700。
 *
 * 登录法三条：邮箱收 6 位码，或 GitHub、Google 授权。没有口令，也就没有「注册」这一步——
 * 收得到验证码的邮箱、登得进那个邮箱的人就是号主，第一次登录同时就是注册。
 * 哪几条能摆出来问的是 /__capabilities：这台机器没配齐凭据的那条不进界面。
 * 这一层随时关得掉：没登录的人本来就在里面逛着，是动手那一下才需要它。
 */
const emit = defineEmits<{ close: [] }>()

const { sendCode: request, verifyCode, githubLogin, googleLogin } = useAuth()

const emailRef = ref<HTMLInputElement | null>(null)
const email = ref('')
const code = ref('')
const busy = ref(false)
const sending = ref(false)
const error = ref('')
/** 说了句实话但不是出错：本机没配发件箱时，码在日志里，这种要用正色而不是红字 */
const hint = ref('')
/** 已经发出去的那一封发到哪个邮箱：没发过就先把验证码框灰着，免得人以为可以空填 */
const sentTo = ref('')
const secsLeft = ref(0)

const emailOk = computed(() => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim()))
const canSend = computed(() => emailOk.value && !sending.value && secsLeft.value <= 0)

let timer = 0
function startCountdown(sec: number) {
  secsLeft.value = Math.max(1, Math.floor(sec))
  window.clearInterval(timer)
  timer = window.setInterval(() => {
    secsLeft.value -= 1
    if (secsLeft.value <= 0) window.clearInterval(timer)
  }, 1000)
}

const sendLabel = computed(() => {
  if (sending.value) return '发送中…'
  if (secsLeft.value > 0) return `${secsLeft.value} 秒后重发`
  return sentTo.value ? '重新发送' : '发送验证码'
})

async function onSendCode() {
  if (!canSend.value) return
  sending.value = true
  error.value = ''
  hint.value = ''
  const o = await request(email.value.trim())
  sending.value = false
  if (!o.ok) {
    error.value = o.error || '验证码没发出去，再试一次'
    if (o.resendIn) startCountdown(o.resendIn)
    return
  }
  sentTo.value = email.value.trim()
  code.value = ''
  startCountdown(o.resendIn || 60)
  // 本机没配发件箱时服务端把码打进日志，界面得说实话，别让人对着空收件箱干等
  if (o.mailSent === false) hint.value = '这台机器没配发件箱，验证码在服务端日志里'
}

async function onSubmit() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  hint.value = ''
  const o = await verifyCode(email.value.trim(), code.value.trim())
  busy.value = false
  if (o.ok) {
    // 游客手上那份是演示产物，登进来要换成号主自己的：整页重取一次才看得见真东西
    if (isGuest.value) location.reload()
    return
  }
  error.value = o.error || '没登进来，再试一次'
  if (o.resendIn) startCountdown(o.resendIn)
  // 码作废的那几种（过期、错过太多次）要让人立刻回去重发，不是再猜一次
  if (o.reason === 'expired' || o.reason === 'too_many' || o.reason === 'no_code') sentTo.value = ''
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  // v-dialog 先把焦点收在面板上，这一拍要排在它后面才抢得到
  requestAnimationFrame(() => emailRef.value?.focus())
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.clearInterval(timer)
})
</script>

<template>
  <div v-dialog="'登录'" class="modal modal--center z-[2110]" @click.self="emit('close')">
    <div class="a2-panel">
      <button class="a2-close" aria-label="关闭" title="关闭" @click="emit('close')">
        <IconX :size="15" />
      </button>

      <aside class="a2-visual" aria-hidden="true">
        <span class="a2-photo"></span>
        <div class="a2-brand">
          <img class="a2-mark" :src="'/favicon.svg'" alt="" width="44" height="44" />
          <span class="a2-brand-name">Media Hub</span>
        </div>
        <h2 class="a2-headline">灵感、选题、成片、发布<br />一个平台跑完</h2>
      </aside>

      <div class="a2-form">
        <h1 class="a2-title">登录</h1>

        <div v-if="loginViaGithub || loginViaGoogle" class="a2-oauths">
          <button v-if="loginViaGithub" class="a2-oauth" type="button" @click="githubLogin">
            <svg viewBox="0 0 98 96" width="18" height="18" aria-hidden>
              <path
                fill="currentColor"
                fill-rule="evenodd"
                clip-rule="evenodd"
                d="M48.854 0C21.839 0 0 22 0 49.13c0 21.65 13.988 39.936 33.416 46.385 2.443.468 3.34-1.06 3.34-2.36 0-1.17-.042-4.32-.064-8.47C23.772 87.4 20.796 79.26 20.796 79.26c-2.225-5.64-5.43-7.14-5.43-7.14-4.447-3.04.354-3.06.354-3.06 4.914.346 7.5 5.05 7.5 5.05 4.37 7.5 11.46 5.33 14.26 4.08.437-3.17 1.715-5.33 3.12-6.55-10.866-1.24-22.27-5.44-22.27-24.24 0-5.35 1.914-9.72 5.054-13.14-.506-1.24-2.186-6.22.477-12.96 0 0 4.124-1.32 13.5 5.05a46 46 0 0 1 12.31-1.66c4.18.02 8.39.57 12.31 1.66 9.37-6.37 13.49-5.05 13.49-5.05 2.67 6.74 1 11.72.49 12.96 3.15 3.42 5.05 7.79 5.05 13.14 0 18.85-11.43 22.99-22.33 24.21 1.76 1.52 3.33 4.5 3.33 9.06 0 6.55-.06 11.82-.06 13.44 0 1.31.87 2.85 3.34 2.36C77.03 89.06 91 70.78 91 49.13 91 22 69.16 0 42.15 0z"
                transform="translate(3.5 0)"
              />
            </svg>
            使用 GitHub 登录
          </button>

          <button v-if="loginViaGoogle" class="a2-oauth" type="button" @click="googleLogin">
            <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden>
              <path
                fill="#4285F4"
                d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.08 5.08-4.4 6.64v5.52h7.12c4.16-3.83 6.56-9.47 6.56-16.17z"
              />
              <path
                fill="#34A853"
                d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.12-5.52c-1.97 1.32-4.5 2.09-7.44 2.09-5.73 0-10.58-3.87-12.31-9.07H4.48v5.71C8.12 41.96 15.47 46 24 46z"
              />
              <path
                fill="#FBBC05"
                d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.71H4.48C2.91 17.03 2 20.41 2 24s.91 6.97 2.48 9.89l7.21-5.71z"
              />
              <path
                fill="#EA4335"
                d="M24 10.18c3.23 0 6.13 1.11 8.41 3.29l6.3-6.3C34.91 4.18 29.93 2 24 2 15.47 2 8.12 6.04 4.48 14.11l7.21 5.71c1.73-5.2 6.58-9.64 12.31-9.64z"
              />
            </svg>
            使用 Google 登录
          </button>
        </div>

        <p v-else-if="!loginViaMail" class="a2-note">这台机器没配登录用的凭据。</p>

        <template v-if="loginViaMail">
          <p class="a2-or"><span>或者</span></p>

          <form class="a2-fields" @submit.prevent="onSubmit">
            <input
              ref="emailRef"
              v-model="email"
              class="a2-input"
              type="email"
              name="email"
              autocomplete="username"
              aria-label="邮箱地址"
              placeholder="邮箱地址"
              required
              :disabled="busy"
            />

            <div class="a2-codewrap">
              <input
                v-model="code"
                class="a2-input a2-input--code"
                inputmode="numeric"
                autocomplete="one-time-code"
                name="code"
                aria-label="6 位验证码"
                placeholder="6 位验证码"
                maxlength="6"
                pattern="\d{6}"
                required
                :disabled="busy || !sentTo"
              />
              <button class="a2-send" type="button" :disabled="!canSend" @click="onSendCode">
                {{ sendLabel }}
              </button>
            </div>

            <button class="a2-go" type="submit" :disabled="busy || !sentTo">
              {{ busy ? '稍等…' : '登录' }}
            </button>
          </form>

          <p v-if="error" class="a2-err">{{ error }}</p>
          <p v-else-if="authFlash" class="a2-err">{{ authFlash }}</p>
          <p v-else-if="hint" class="a2-foot">{{ hint }}</p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 双栏等宽（照 auth-2 的 md:grid-cols-2）。右栏跟着三套主题走，左栏那张照片永远压深色字：
   照片本身是亮青色，深色主题下把标题翻成白字会直接糊在图上。 */
.a2-panel {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  width: 940px;
  max-width: 100%;
  min-height: 520px;
  max-height: 100%;
  overflow: hidden;
  border: var(--app-border-w) solid var(--app-line-strong);
  border-radius: var(--app-radius-lg);
  background: var(--app-surface);
  box-shadow: var(--app-shadow-lg);
  animation: a2-in 0.2s cubic-bezier(0.23, 1, 0.32, 1);
}

@keyframes a2-in {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.a2-close {
  position: absolute;
  right: 14px;
  top: 14px;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 9999px;
  background: transparent;
  color: #1a1a1a;
  cursor: pointer;
  transition: background 0.15s ease;
}

.a2-close:hover {
  background: rgba(255, 255, 255, 0.6);
}

/* ---------- 左：品牌照片 ---------- */

.a2-visual {
  position: relative;
  display: none;
  overflow: hidden;
  border-right: var(--app-border-w) solid var(--app-line);
  background: var(--app-surface-2);
}

/* 底图就是 auth-2 预览里那张：照片在顶层，青色渐变垫在下面——
   离线或桌面壳里取不到图时，左栏还是一块青色，不会塌成灰坑。 */
.a2-photo {
  position: absolute;
  inset: 0;
  background-image:
    url("https://images.unsplash.com/photo-1623410439361-22ac19216577?q=80&w=774&auto=format&fit=crop"),
    linear-gradient(165deg, #9fe6f2 0%, #35b8dc 52%, #d8eef1 100%);
  background-size: cover;
  background-position: 50% 100%;
  transform: scale(1.12);
  animation: a2-drift 34s ease-in-out infinite alternate;
}

@keyframes a2-drift {
  from {
    transform: scale(1.12) translate3d(-1%, -1%, 0);
  }
  to {
    transform: scale(1.2) translate3d(1.5%, 1%, 0);
  }
}

.a2-brand {
  position: absolute;
  left: 26px;
  top: 24px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.a2-mark {
  width: 44px;
  height: 44px;
  display: block;
  border-radius: 14px;
}

.a2-brand-name {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.4px;
  color: #1a1a1a;
}

.a2-headline {
  position: absolute;
  left: 26px;
  right: 20px;
  bottom: 26px;
  margin: 0;
  font-size: 30px;
  font-weight: 700;
  line-height: 1.28;
  letter-spacing: -0.8px;
  color: #1a1a1a;
}

/* ---------- 右：表单 ---------- */

.a2-form {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 40px 40px;
}

.a2-title {
  margin: 0 0 22px;
  font-size: 32px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.8px;
  color: var(--app-ink);
}

/* OAuth 按钮叠着排：配了几家就几颗，两颗以上才需要这道间距 */
.a2-oauths {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
}

.a2-oauth {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  height: 48px;
  padding: 0 24px;
  border: var(--app-border-w) solid var(--app-line-strong);
  border-radius: 16px;
  background: var(--app-surface-2);
  font-family: inherit;
  font-size: 15px;
  font-weight: 600;
  color: var(--app-ink);
  cursor: pointer;
  transition:
    background 0.15s ease,
    transform 0.15s ease;
}

.a2-oauth:hover {
  background: color-mix(in oklab, var(--app-surface-2) 70%, var(--app-ink) 6%);
}

.a2-oauth:active {
  transform: scale(0.99);
}

.a2-or {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 20px 0;
  font-size: 13px;
  color: var(--app-ink-3);
}

.a2-or::before,
.a2-or::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--app-line);
}

.a2-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
}

.a2-input {
  width: 100%;
  height: 48px;
  padding: 0 16px;
  border: var(--app-border-w) solid var(--app-line-strong);
  border-radius: 16px;
  background: var(--app-canvas);
  font-family: inherit;
  font-size: 15px;
  color: var(--app-ink);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.a2-input::placeholder {
  color: var(--app-ink-3);
}

.a2-input:focus {
  outline: none;
  border-color: var(--app-accent);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--app-accent) 26%, transparent);
}

.a2-input:disabled {
  opacity: 0.6;
}

/* 验证码框：发送按钮压在框内右侧，和参考里那颗眼睛同一个位置 */
.a2-codewrap {
  position: relative;
}

.a2-input--code {
  padding-right: 118px;
  letter-spacing: 2px;
}

.a2-send {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  color: var(--app-accent);
  cursor: pointer;
  transition:
    color 0.15s ease,
    background 0.15s ease;
}

.a2-send:hover:not(:disabled) {
  background: var(--app-accent-soft);
}

.a2-send:disabled {
  color: var(--app-ink-3);
  cursor: not-allowed;
}

.a2-go {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 48px;
  padding: 0 16px;
  margin-top: 4px;
  border: 0;
  border-radius: 16px;
  /* 主按钮用墨色实底：浅色主题黑底白字、深色主题白底黑字，和参考里那颗反色按钮一个做法 */
  background: var(--app-ink);
  font-family: inherit;
  font-size: 15px;
  font-weight: 600;
  color: var(--app-canvas);
  cursor: pointer;
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.a2-go:hover:not(:disabled) {
  opacity: 0.88;
}

.a2-go:active:not(:disabled) {
  transform: scale(0.99);
}

.a2-go:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.a2-err {
  margin: 14px 0 0;
  font-size: 13px;
  line-height: 18px;
  color: var(--app-danger-text);
}

.a2-note,
.a2-foot {
  margin: 14px 0 0;
  font-size: 13px;
  line-height: 18px;
  color: var(--app-ink-3);
}

@media (min-width: 860px) {
  .a2-visual {
    display: block;
  }
}

@media (max-width: 859px) {
  .a2-panel {
    grid-template-columns: minmax(0, 1fr);
    min-height: 0;
    overflow-y: auto;
  }

  .a2-form {
    padding: 44px 22px 30px;
  }

  .a2-title {
    font-size: 26px;
  }

  .a2-close {
    color: var(--app-ink-3);
  }
}

@media (prefers-reduced-motion: reduce) {
  .a2-panel,
  .a2-photo {
    animation: none;
  }
}
</style>
