<script setup lang="ts">
/**
 * 整页背景点阵：鼠标推着走的弹簧格子，没人碰的时候一条亮带自己慢慢游。
 * 引擎从 build-hub 首页那颗 DotField 移植，为工作台改了三处——
 * 配色跟着 <html data-theme> 现取（三套皮肤各一档浓淡）、滚动认的是任意一条真在滚的滚动条、
 * 点距收小且亮度压低：这屏要盯一整天，背景只能安静。
 * `vivid` 那一档给对话页：这屏几乎全空，背景是唯一在动的东西，所以光带更亮、爬得更快、入场那道扫光更实。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(defineProps<{ vivid?: boolean }>(), { vivid: false })

const el = ref<HTMLCanvasElement | null>(null)
let dispose: (() => void) | null = null

onMounted(() => {
  if (el.value) dispose = createField(el.value, () => props.vivid)
})
onBeforeUnmount(() => dispose?.())
</script>

<template>
  <canvas ref="el" class="block h-full w-full" />
</template>

<script lang="ts">
type RGB = [number, number, number]

/** 三套皮肤各一档：工作台要盯一整天，浅色两档都压在低档，暗色也只留一点呼吸。
    base 是静息那点色，必须比画布暗才读得出；ambient 是那几团游动的光有多亮。 */
const SKINS: Record<string, { base: string; active: string; opacity: number; ambient: number }> = {
  pro: { base: '#dce1ea', active: '#4660d4', opacity: 0.5, ambient: 0.34 },
  neo: { base: '#dccdb0', active: '#111111', opacity: 0.2, ambient: 0.12 },
  dark: { base: '#20202a', active: '#8f87e8', opacity: 0.6, ambient: 0.22 },
}

const CFG = {
  dotSize: 2.5,
  gap: 26,
  proximity: 120,
  strength: 0.5,
  bounce: 0.6,
  tension: 0.4,
  returnDuration: 0.8,
  shockRadius: 200,
  shockStrength: 3,
  swell: 0.4,
  stretch: 0.5,
  glow: 0.25,
  fade: 0.55,
  scrollSway: 0.3,
  bandSpeed: 0.07,
}

/** 两档浓淡：其余各站的背景压在白卡后面，只留安静那档 */
const CALM = { opacity: 1, ambient: 1, band: 1, intro: 0.22, gamma: 1, tint: 1.2, wave: [360, 520] }
const VIVID = { opacity: 1.2, ambient: 2.2, band: 1.9, intro: 0.55, gamma: 0.5, tint: 2.6, wave: [660, 940] }

function parseColor(color: string): RGB {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!match) return [255, 255, 255]
  const hex = match[1].length === 3 ? match[1].replace(/./g, (d) => d + d) : match[1]
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ]
}

const smootherstep = (t: number) => {
  const x = Math.min(1, Math.max(0, t))
  return x * x * x * (x * (x * 6 - 15) + 10)
}

const backOut = (t: number) => {
  const s = 1.9
  const x = t - 1
  return 1 + x * x * ((s + 1) * x + s)
}

const STEPS = 24
const TAU = Math.PI * 2

function createField(canvas: HTMLCanvasElement, isVivid: () => boolean): () => void {
  const context = canvas.getContext('2d', { alpha: true })
  if (!context) return () => {}
  // 提成非空常量再给下面那些函数用：函数声明会提升，TS 不肯在提升的作用域里沿用上面的判空
  const ctx: CanvasRenderingContext2D = context

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const view = { width: 0, height: 0, ratio: 1 }
  const grid = { count: 0, cols: 1, rows: 1, cell: 1, centerX: 0, centerY: 0, reach: 1 }
  let skin = SKINS.pro
  let rest = new Float32Array(0)
  let offset = new Float32Array(0)
  let velocity = new Float32Array(0)
  let force = new Float32Array(0)
  let next = new Float32Array(0)
  let wave = new Float32Array(0)
  let energy = new Float32Array(0)
  const pointer = { x: 0, y: 0, vx: 0, vy: 0, time: 0, inside: false, presence: 0 }
  const shocks: { x: number; y: number; start: number }[] = []
  /** 环境光带：phase 走到哪一格，push 是滚动给的一脚油门 */
  const flow = { phase: 0, push: 0 }
  let quiet = true
  let introStart: number | null = reduced ? null : -1
  let visible = true
  let raf = 0
  let last = 0
  let palette: string[] = []
  let paletteKey = ''

  const buildPalette = () => {
    const key = `${skin.base}-${skin.active}`
    if (key === paletteKey) return
    paletteKey = key
    const from = parseColor(skin.base)
    const to = parseColor(skin.active)
    palette = Array.from({ length: STEPS }, (_, i) => {
      const t = i / (STEPS - 1)
      return `rgb(${Math.round(from[0] + (to[0] - from[0]) * t)},${Math.round(
        from[1] + (to[1] - from[1]) * t,
      )},${Math.round(from[2] + (to[2] - from[2]) * t)})`
    })
  }

  const rebuild = () => {
    const size = CFG.dotSize
    const spacing = CFG.gap
    let cell = Math.max(2, size + spacing)
    let cols = Math.max(1, Math.floor((view.width + spacing) / cell))
    let rows = Math.max(1, Math.floor((view.height + spacing) / cell))
    // 4K 屏上能排上万个点；超预算就等比放大格距，只稀不卡
    const budget = 4600
    if (cols * rows > budget) {
      cell = Math.ceil(cell * Math.sqrt((cols * rows) / budget))
      cols = Math.max(1, Math.floor((view.width + spacing) / cell))
      rows = Math.max(1, Math.floor((view.height + spacing) / cell))
    }
    const startX = (view.width - (cols * cell - spacing)) / 2 + size / 2
    const startY = (view.height - (rows * cell - spacing)) / 2 + size / 2
    const count = cols * rows
    rest = new Float32Array(count * 2)
    offset = new Float32Array(count * 2)
    velocity = new Float32Array(count * 2)
    force = new Float32Array(count * 2)
    next = new Float32Array(count * 2)
    wave = new Float32Array(count * 4)
    energy = new Float32Array(count)
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const i = (row * cols + col) * 2
        rest[i] = startX + col * cell
        rest[i + 1] = startY + row * cell
      }
    }
    Object.assign(grid, {
      count,
      cols,
      rows,
      cell,
      centerX: view.width / 2,
      centerY: view.height / 2,
      reach: Math.hypot(view.width, view.height) / 2,
    })
  }

  const resize = () => {
    const rect = canvas.getBoundingClientRect()
    view.ratio = Math.min(window.devicePixelRatio || 1, 2)
    view.width = Math.max(1, Math.round(rect.width))
    view.height = Math.max(1, Math.round(rect.height))
    canvas.width = Math.round(view.width * view.ratio)
    canvas.height = Math.round(view.height * view.ratio)
    ctx.setTransform(view.ratio, 0, 0, view.ratio, 0, 0)
    rebuild()
    render(performance.now())
  }

  function step(dt: number, now: number) {
    const motion = reduced ? 0 : 1
    const prof = isVivid() ? VIVID : CALM
    // 光带自己往前爬；滚动踩的那一脚油门在半秒内褪掉，不会一直窜
    flow.push *= 1 - Math.exp(-dt / 0.5)
    flow.phase += dt * (CFG.bandSpeed * prof.band + flow.push * motion * CFG.scrollSway)
    const zeta = 1 - 0.85 * Math.min(1, Math.max(0, CFG.bounce))
    const omega = 4 / (zeta * Math.max(0.2, CFG.returnDuration))
    const stiffness = omega * omega
    const damping = 2 * zeta * omega
    const radius = Math.max(1, CFG.proximity)
    const speed = Math.hypot(pointer.vx, pointer.vy)
    const drive =
      !reduced && pointer.inside
        ? 6500 * Math.tanh(speed / 900) * CFG.strength * motion
        : 0
    const dirX = speed > 0.001 ? pointer.vx / speed : 0
    const dirY = speed > 0.001 ? pointer.vy / speed : 0
    const band = grid.cell * 1.4
    const travel = 650
    const active = shocks.map((shock) => {
      const front = ((now - shock.start) / 1000) * travel
      const power = smootherstep(1 - front / Math.max(1, CFG.shockRadius))
      return {
        ...shock,
        front,
        amplitude: power * CFG.shockStrength * grid.cell * 0.24 * motion,
      }
    })
    const coupling = (Math.max(0, CFG.tension) * 900) ** 2 / (grid.cell * grid.cell)
    const viscosity = Math.sqrt(coupling) * 0.06
    const limit = Math.sqrt(stiffness + 8 * coupling) + damping + 8 * viscosity
    const steps = Math.min(24, Math.max(1, Math.ceil(dt / Math.min(1 / 120, 1.2 / limit))))
    const h = dt / steps

    if (drive > 0 || active.length > 0) quiet = false

    if (!quiet) {
      for (let i = 0; i < grid.count; i++) {
        const index = i * 2
        const rx = rest[index]
        const ry = rest[index + 1]
        let ax = 0
        let ay = 0
        if (drive > 0) {
          const ex = rx + offset[index] - pointer.x
          const ey = ry + offset[index + 1] - pointer.y
          const distance = Math.hypot(ex, ey)
          if (distance < radius) {
            const weight = smootherstep(1 - distance / radius) * drive
            const nx = distance > 0.001 ? ex / distance : 0
            const ny = distance > 0.001 ? ey / distance : 0
            ax += weight * (dirX + nx * 0.6)
            ay += weight * (dirY + ny * 0.6)
          }
        }
        let wx = 0
        let wy = 0
        let wvx = 0
        let wvy = 0
        for (const shock of active) {
          if (shock.amplitude <= 0) continue
          const ex = rx - shock.x
          const ey = ry - shock.y
          const distance = Math.hypot(ex, ey)
          const u = (distance - shock.front) / band
          if (Math.abs(u) < 3 && distance > 0.001) {
            const nx = ex / distance
            const ny = ey / distance
            const profile = Math.exp(-u * u)
            const push = shock.amplitude * profile
            const rate = ((shock.amplitude * 2 * u * profile) / band) * travel
            wx += nx * push
            wy += ny * push
            wvx += nx * rate
            wvy += ny * rate
            ax += nx * push * stiffness * 0.35
            ay += ny * push * stiffness * 0.35
          }
        }
        force[index] = ax
        force[index + 1] = ay
        const target = i * 4
        wave[target] = wx
        wave[target + 1] = wy
        wave[target + 2] = wvx
        wave[target + 3] = wvy
      }

      const stride = grid.cols * 2
      for (let n = 0; n < steps; n++) {
        for (let row = 0; row < grid.rows; row++) {
          for (let col = 0; col < grid.cols; col++) {
            const index = (row * grid.cols + col) * 2
            let ax = force[index] - stiffness * offset[index] - damping * velocity[index]
            let ay =
              force[index + 1] - stiffness * offset[index + 1] - damping * velocity[index + 1]
            if (coupling > 0) {
              let lx = -4 * offset[index]
              let ly = -4 * offset[index + 1]
              let mx = -4 * velocity[index]
              let my = -4 * velocity[index + 1]
              if (col > 0) {
                lx += offset[index - 2]
                ly += offset[index - 1]
                mx += velocity[index - 2]
                my += velocity[index - 1]
              }
              if (col < grid.cols - 1) {
                lx += offset[index + 2]
                ly += offset[index + 3]
                mx += velocity[index + 2]
                my += velocity[index + 3]
              }
              if (row > 0) {
                lx += offset[index - stride]
                ly += offset[index - stride + 1]
                mx += velocity[index - stride]
                my += velocity[index - stride + 1]
              }
              if (row < grid.rows - 1) {
                lx += offset[index + stride]
                ly += offset[index + stride + 1]
                mx += velocity[index + stride]
                my += velocity[index + stride + 1]
              }
              ax += coupling * lx + viscosity * mx
              ay += coupling * ly + viscosity * my
            }
            next[index] = velocity[index] + ax * h
            next[index + 1] = velocity[index + 1] + ay * h
          }
        }
        for (let i = 0; i < offset.length; i++) {
          velocity[i] = next[i]
          offset[i] += velocity[i] * h
        }
      }

      for (let i = 0; i < grid.count; i++) {
        const index = i * 2
        const target = i * 4
        energy[i] = Math.min(
          1,
          (Math.hypot(
            velocity[index] + wave[target + 2],
            velocity[index + 1] + wave[target + 3],
          ) /
            380) *
            0.85 +
            (Math.hypot(
              offset[index] + wave[target],
              offset[index + 1] + wave[target + 1],
            ) /
              (grid.cell * 2.2)) *
              0.35,
        )
      }

      // 指针和点击波都撤了、格子也归位了：下一帧起只走光带，省下最贵的那段积分
      if (drive <= 0 && active.length === 0) {
        let moved = false
        for (let i = 0; i < offset.length; i += 5) {
          if (Math.abs(offset[i]) > 0.02 || Math.abs(velocity[i]) > 0.5) {
            moved = true
            break
          }
        }
        if (!moved) {
          quiet = true
          offset.fill(0)
          velocity.fill(0)
          energy.fill(0)
        }
      }
    }
    for (let i = shocks.length - 1; i >= 0; i--) {
      if (active[i].front > CFG.shockRadius + band * 3) shocks.splice(i, 1)
    }
    const decay = 1 - Math.exp(-dt / 0.08)
    pointer.vx -= pointer.vx * decay
    pointer.vy -= pointer.vy * decay
    const presenceTarget = !reduced && pointer.inside ? 1 : 0
    pointer.presence += (presenceTarget - pointer.presence) * (1 - Math.exp(-dt / 0.2))
  }

  function render(now: number) {
    buildPalette()
    const prof = isVivid() ? VIVID : CALM
    const amb = reduced ? 0 : skin.ambient * prof.ambient
    const radius = Math.max(1, CFG.proximity)
    const size = Math.max(0.5, CFG.dotSize)
    const introAge = introStart === null ? Infinity : introStart < 0 ? 0 : (now - introStart) / 1000
    const introFront = introAge * grid.reach * 1.25
    const introBand = grid.cell * 4
    const edge = Math.max(1, CFG.fade * 0.4 * Math.min(view.width, view.height))
    ctx.clearRect(0, 0, view.width, view.height)
    if (!palette.length) return

    for (let i = 0; i < grid.count; i++) {
      const index = i * 2
      const source = i * 4
      const x = rest[index] + offset[index] + wave[source]
      const y = rest[index + 1] + offset[index + 1] + wave[source + 1]
      let glowing = energy[i]
      if (pointer.presence > 0.001) {
        const distance = Math.hypot(x - pointer.x, y - pointer.y)
        if (distance < radius)
          glowing = Math.max(glowing, smootherstep(1 - distance / radius) * 0.28 * pointer.presence)
      }
      let scale = 1
      if (introStart !== null) {
        const distance = Math.hypot(rest[index] - grid.centerX, rest[index + 1] - grid.centerY)
        const appear = Math.min(1, Math.max(0, (introFront - distance) / introBand))
        scale = appear >= 1 ? 1 : Math.max(0, backOut(appear))
        // 入场那道扫光：安静档只留一点暗示，对话页那档要真看得见
        glowing = Math.max(glowing, Math.sin(appear * Math.PI) * prof.intro)
      }
      if (scale <= 0.01) continue

      if (amb > 0) {
        // 两条不同方向的慢波只在重合处叠出亮斑，游动的是几团光，不是一条直愣愣的扫光。
        // 除数是波长：360/520 是亮斑不被格子采碎的下限，对话页那档取更长，让亮斑连成片
        const [wlA, wlB] = prof.wave
        const a = Math.sin(((rest[index] * 0.8 + rest[index + 1] * 0.6) / wlA - flow.phase) * TAU)
        const b = Math.sin(
          ((rest[index] * -0.55 + rest[index + 1] * 0.84) / wlB + flow.phase * 0.62) * TAU,
        )
        if (a > 0 && b > 0) glowing = Math.max(glowing, amb * (a ** 6 * b ** 3) ** prof.gamma)
      }

      let alpha = skin.opacity * prof.opacity
      if (CFG.fade > 0) {
        alpha *=
          smootherstep(Math.min(x, view.width - x) / edge) *
          smootherstep(Math.min(y, view.height - y) / edge)
      }
      if (alpha <= 0.004) continue

      const r = 0.5 * size * scale * (1 + CFG.swell * glowing)
      const color = palette[Math.min(STEPS - 1, Math.floor(glowing * prof.tint * STEPS))]
      const vx = velocity[index] + wave[source + 2]
      const vy = velocity[index + 1] + wave[source + 3]
      const speed = Math.hypot(vx, vy)
      ctx.fillStyle = color

      if (speed > 40 && glowing > 0.05) {
        const half = Math.min(size * 2, speed * CFG.stretch * 0.02)
        if (half > r * 0.4) {
          ctx.globalAlpha = alpha
          ctx.strokeStyle = color
          ctx.lineWidth = r * 2
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.moveTo(x - (vx / speed) * half, y - (vy / speed) * half)
          ctx.lineTo(x + (vx / speed) * half, y + (vy / speed) * half)
          ctx.stroke()
          continue
        }
      }

      const halo = CFG.glow * glowing
      if (halo > 0.02) {
        ctx.globalAlpha = alpha * Math.min(0.5, halo * 0.4)
        ctx.beginPath()
        ctx.arc(x, y, r * (1 + halo * 2.5), 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = alpha
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }

  function settled(now: number) {
    if (shocks.length) return false
    if (introStart !== null) {
      if (introStart < 0 || (now - introStart) / 1000 < 1.6) return false
      introStart = null
    }
    if (Math.abs(pointer.vx) + Math.abs(pointer.vy) > 1) return false
    const presenceTarget = !reduced && pointer.inside ? 1 : 0
    if (Math.abs(presenceTarget - pointer.presence) > 0.002) return false
    for (let i = 0; i < offset.length; i++) {
      if (Math.abs(offset[i]) > 0.02 || Math.abs(velocity[i]) > 0.5) return false
    }
    return true
  }

  const frame = (now: number) => {
    raf = 0
    if (!visible || document.hidden) return
    if (introStart !== null && introStart < 0) introStart = now
    const dt = Math.min(0.05, (now - last) / 1000 || 0)
    last = now
    step(dt, now)
    render(now)
    // 开了光带就一直呼吸；关掉无障碍动效才允许彻底停下来省电
    if (!settled(now) || (!reduced && skin.ambient > 0)) {
      raf = requestAnimationFrame(frame)
    }
  }

  const wake = () => {
    if (raf || !visible || document.hidden) return
    last = performance.now()
    raf = requestAnimationFrame(frame)
  }

  const locate = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect()
    view.width = Math.max(1, Math.round(rect.width))
    view.height = Math.max(1, Math.round(rect.height))
    return [event.clientX - rect.left, event.clientY - rect.top]
  }

  const onMove = (event: PointerEvent) => {
    if (reduced) return
    const [x, y] = locate(event)
    const inside = x >= 0 && y >= 0 && x <= view.width && y <= view.height
    const time = event.timeStamp || performance.now()
    if (inside && pointer.inside && pointer.time) {
      const elapsed = Math.max(4, time - pointer.time) / 1000
      pointer.vx += ((x - pointer.x) / elapsed - pointer.vx) * 0.6
      pointer.vy += ((y - pointer.y) / elapsed - pointer.vy) * 0.6
    } else {
      pointer.vx = 0
      pointer.vy = 0
    }
    pointer.x = x
    pointer.y = y
    pointer.time = time
    if (inside !== pointer.inside || inside) {
      pointer.inside = inside
      wake()
    }
  }

  const onLeave = () => {
    pointer.inside = false
    pointer.time = 0
    wake()
  }

  const onOut = (event: PointerEvent) => {
    if (!event.relatedTarget) onLeave()
  }

  const onDown = (event: PointerEvent) => {
    if (reduced) return
    const [x, y] = locate(event)
    if (x < 0 || y < 0 || x > view.width || y > view.height) return
    shocks.push({ x, y, start: performance.now() })
    if (shocks.length > 6) shocks.shift()
    wake()
  }

  // 滚动给光带踩一脚油门：往下滚它往前窜，往上滚它倒退，半秒内自己收住。
  // 外壳不滚、只有主区滚，所以用捕获监听收任意一条真在滚的滚动条。
  const lastTops = new WeakMap<EventTarget, number>()
  const onScroll = (event: Event) => {
    const target = event.target
    if (!(target instanceof Element) && target !== document) return
    const top = target instanceof Element ? target.scrollTop : window.scrollY
    const prev = lastTops.get(target)
    lastTops.set(target, top)
    if (reduced || prev === undefined) return
    const dy = top - prev
    if (!dy) return
    flow.push = Math.max(-1.8, Math.min(1.8, flow.push + dy * 0.003))
    wake()
  }

  window.addEventListener('pointermove', onMove, { passive: true })
  window.addEventListener('pointerdown', onDown, { passive: true })
  window.addEventListener('pointerout', onOut)
  window.addEventListener('blur', onLeave)
  window.addEventListener('scroll', onScroll, { passive: true, capture: true })

  const resizeObserver = new ResizeObserver(() => {
    resize()
    wake()
  })
  resizeObserver.observe(canvas)

  const visibilityObserver = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    if (visible) wake()
  })
  visibilityObserver.observe(canvas)

  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf)
      raf = 0
    } else {
      wake()
    }
  }
  document.addEventListener('visibilitychange', onVisibility)

  // 三套皮肤换的是同一层背景：主题一挂上就重取浓淡，不重建格子
  const applySkin = () => {
    skin = SKINS[document.documentElement.dataset.theme ?? ''] ?? SKINS.pro
    buildPalette()
    render(performance.now())
    wake()
  }
  const themeObserver = new MutationObserver(applySkin)
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
  applySkin()
  resize()
  wake()

  return () => {
    cancelAnimationFrame(raf)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerdown', onDown)
    window.removeEventListener('pointerout', onOut)
    window.removeEventListener('blur', onLeave)
    window.removeEventListener('scroll', onScroll, { capture: true })
    document.removeEventListener('visibilitychange', onVisibility)
    resizeObserver.disconnect()
    visibilityObserver.disconnect()
    themeObserver.disconnect()
  }
}
</script>
