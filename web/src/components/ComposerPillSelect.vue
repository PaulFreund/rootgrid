<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Check, ChevronDown } from 'lucide-vue-next'

const props = defineProps({
  modelValue: {
    type: String,
    default: ''
  },
  options: {
    type: Array,
    default: () => []
  },
  title: {
    type: String,
    default: ''
  },
  disabled: {
    type: Boolean,
    default: false
  },
  size: {
    type: String,
    default: 'md'
  }
})

const emit = defineEmits(['update:modelValue'])

const rootEl = ref(null)
const menuEl = ref(null)
const open = ref(false)
const hoveredIndex = ref(-1)
const menuStyle = ref({})

const selectedOption = computed(() => {
  const current = String(props.modelValue ?? '')
  return (Array.isArray(props.options) ? props.options : []).find((option) => String(option?.value ?? '') === current) ?? null
})

const buttonLabel = computed(() => {
  return String(selectedOption.value?.label ?? '').trim() || String(props.title ?? '').trim() || 'Select'
})

const buttonClasses = computed(() => (
  props.size === 'sm'
    ? 'h-7 px-3 pr-6 text-[11px] leading-[1.2]'
    : 'h-8 px-3.5 pr-[26px] text-[12px] leading-[1.2]'
))

const menuRowClasses = computed(() => (
  props.size === 'sm'
    ? 'px-2.5 py-1.5 text-[12px] leading-[1.25]'
    : 'px-2.5 py-2 text-[13px] leading-[1.25]'
))

const hoveredOption = computed(() => {
  const index = Number(hoveredIndex.value)
  if (!Number.isInteger(index) || index < 0) return null
  return (Array.isArray(props.options) ? props.options[index] : null) ?? null
})

const hoveredDescription = computed(() => String(hoveredOption.value?.description ?? '').trim())

const hoveredDescriptionStyle = computed(() => {
  const index = Math.max(0, Number(hoveredIndex.value) || 0)
  const rowHeight = props.size === 'sm' ? 34 : 38
  const topOffset = (props.title ? 28 : 6) + (index * rowHeight)
  return { top: `${topOffset}px` }
})

function closeMenu() {
  open.value = false
  hoveredIndex.value = -1
}

async function toggleMenu() {
  if (props.disabled) return
  open.value = !open.value
  if (!open.value) {
    hoveredIndex.value = -1
    return
  }
  await nextTick()
  updateMenuPosition()
}

function selectOption(option) {
  emit('update:modelValue', String(option?.value ?? ''))
  closeMenu()
}

function handlePointerDown(event) {
  if (!open.value) return
  const root = rootEl.value
  const menu = menuEl.value
  if (root && root.contains(event.target)) return
  if (menu && menu.contains(event.target)) return
  closeMenu()
}

function handleKeyDown(event) {
  if (event.key === 'Escape') closeMenu()
}

function updateMenuPosition() {
  if (!open.value) return
  const root = rootEl.value
  const menu = menuEl.value
  if (!root || !menu || typeof window === 'undefined') return
  const rect = root.getBoundingClientRect()
  const viewportWidth = Math.max(0, Number(window.innerWidth ?? 0))
  const viewportHeight = Math.max(0, Number(window.innerHeight ?? 0))
  const gap = 8
  const horizontalMargin = 12
  const menuWidth = Math.max(rect.width, menu.offsetWidth || 0)
  const menuHeight = menu.offsetHeight || 0
  const fitsBelow = rect.bottom + gap + menuHeight <= viewportHeight - horizontalMargin
  const top = fitsBelow
    ? rect.bottom + gap
    : Math.max(horizontalMargin, rect.top - gap - menuHeight)
  const maxLeft = Math.max(horizontalMargin, viewportWidth - menuWidth - horizontalMargin)
  const left = Math.min(Math.max(horizontalMargin, rect.left), maxLeft)
  menuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    minWidth: `${Math.round(rect.width)}px`
  }
}

watch(() => props.disabled, (disabled) => {
  if (disabled) closeMenu()
})

watch(open, async (isOpen) => {
  if (!isOpen) return
  await nextTick()
  updateMenuPosition()
})

function handleViewportChange() {
  if (!open.value) return
  updateMenuPosition()
}

onMounted(() => {
  try { window.addEventListener('pointerdown', handlePointerDown) } catch {}
  try { window.addEventListener('keydown', handleKeyDown) } catch {}
  try { window.addEventListener('resize', handleViewportChange) } catch {}
  try { window.addEventListener('scroll', handleViewportChange, true) } catch {}
})

onBeforeUnmount(() => {
  try { window.removeEventListener('pointerdown', handlePointerDown) } catch {}
  try { window.removeEventListener('keydown', handleKeyDown) } catch {}
  try { window.removeEventListener('resize', handleViewportChange) } catch {}
  try { window.removeEventListener('scroll', handleViewportChange, true) } catch {}
})
</script>

<template>
  <div ref="rootEl" class="relative inline-flex max-w-full align-middle">
    <button
      type="button"
      :disabled="disabled"
      :title="title || buttonLabel"
      class="inline-flex max-w-full items-center rounded-full border bg-transparent text-slate-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/20 disabled:cursor-not-allowed disabled:opacity-40"
      :class="[buttonClasses, open ? 'border-black/[0.08]' : 'border-transparent hover:bg-black/[0.03]']"
      @click="toggleMenu"
    >
      <span class="block truncate pb-[1px] leading-[1.2]">{{ buttonLabel }}</span>
      <span class="pointer-events-none absolute right-[7px] top-1/2 inline-flex -translate-y-1/2 items-center justify-center text-slate-400">
        <ChevronDown class="h-3.5 w-3.5" />
      </span>
    </button>
  </div>

  <teleport to="body">
    <div
      v-if="open"
      ref="menuEl"
      class="fixed z-[120]"
      :style="menuStyle"
    >
      <div class="relative overflow-visible rounded-2xl border border-black/[0.08] bg-white p-1.5 shadow-[0_12px_30px_rgba(15,23,42,0.14)]">
        <div v-if="title" class="px-2.5 pb-1 pt-0.5 text-[12px] text-slate-400">{{ title }}</div>

        <button
          v-for="(option, index) in options"
          :key="`${option?.value ?? ''}-${index}`"
          type="button"
          class="flex w-full min-w-[160px] items-center justify-between gap-3 rounded-xl text-left transition-colors"
          :class="[
            menuRowClasses,
            String(option?.value ?? '') === String(modelValue ?? '')
              ? 'bg-black/[0.06] text-slate-900'
              : 'text-slate-700 hover:bg-black/[0.04]'
          ]"
          @mouseenter="hoveredIndex = index"
          @focus="hoveredIndex = index"
          @mouseleave="hoveredIndex = -1"
          @click="selectOption(option)"
        >
          <span class="truncate pb-[1px] leading-[1.25]">{{ option?.label }}</span>
          <Check
            v-if="String(option?.value ?? '') === String(modelValue ?? '')"
            class="h-3.5 w-3.5 shrink-0 text-slate-700"
          />
        </button>

        <div
          v-if="hoveredDescription"
          class="pointer-events-none absolute left-full ml-2 hidden min-w-[220px] max-w-[280px] rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-[12px] text-slate-600 shadow-[0_10px_24px_rgba(15,23,42,0.12)] lg:block"
          :style="hoveredDescriptionStyle"
        >
          {{ hoveredDescription }}
        </div>
      </div>
    </div>
  </teleport>
</template>
