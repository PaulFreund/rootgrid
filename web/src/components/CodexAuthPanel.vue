<script setup>
import { computed } from 'vue'
import { Loader2, RotateCw } from 'lucide-vue-next'

const props = defineProps({
  tool: {
    type: Object,
    default: null
  },
  webAuthSupported: {
    type: Boolean,
    default: true
  },
  supportMessage: {
    type: String,
    default: ''
  },
  busy: {
    type: Boolean,
    default: false
  },
  authErrorText: {
    type: String,
    default: ''
  },
  authStatusText: {
    type: String,
    default: ''
  }
})

const emit = defineEmits(['refresh', 'start-device-auth', 'cancel-device-auth', 'logout'])

const authFlow = computed(() => {
  const flow = props.tool?.auth?.flow
  return (flow && typeof flow === 'object') ? flow : null
})

const authFlowActive = computed(() => Boolean(authFlow.value?.active))

const authLabel = computed(() => {
  if (authFlowActive.value) return 'Browser sign-in in progress'
  const status = String(props.tool?.auth?.status ?? '').trim()
  if (status === 'authenticated') return 'Signed in'
  if (status === 'pending-browser-auth') return 'Browser sign-in in progress'
  if (status === 'reauth-required') return 'Reauthentication required'
  if (status === 'not-authenticated') return 'Not signed in'
  if (status === 'unavailable') return 'Unavailable'
  return 'Unknown'
})

const authLabelClass = computed(() => {
  if (authFlowActive.value) return 'text-indigo-700'
  const status = String(props.tool?.auth?.status ?? '').trim()
  if (status === 'authenticated') return 'text-emerald-700'
  if (status === 'pending-browser-auth') return 'text-indigo-700'
  if (status === 'reauth-required') return 'text-red-600'
  if (status === 'not-authenticated') return 'text-amber-700'
  return 'text-slate-500'
})
</script>

<template>
  <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="text-[11px] uppercase tracking-wider text-slate-500">Authentication</div>
        <div class="mt-1 text-xs font-medium" :class="authLabelClass">
          {{ authLabel }}
        </div>
        <div v-if="tool?.auth?.message" class="mt-1 text-[11px] text-slate-500">
          {{ tool.auth.message }}
        </div>
      </div>
      <button
        v-if="webAuthSupported"
        class="inline-flex shrink-0 items-center gap-2 rounded-md bg-white px-2.5 py-1.5 text-xs text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="busy || authFlowActive"
        title="Refresh Codex sign-in status on this runner."
        @click="emit('refresh')"
      >
        <Loader2 v-if="busy" class="h-3.5 w-3.5 animate-spin" />
        <RotateCw v-else class="h-3.5 w-3.5" />
        Recheck
      </button>
    </div>

    <div v-if="webAuthSupported" class="mt-3 flex flex-wrap items-center gap-2">
      <button
        v-if="!authFlowActive"
        class="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="busy"
        @click="emit('start-device-auth')"
      >
        Sign in with ChatGPT
      </button>
      <button
        v-else
        class="rounded-md bg-white px-3 py-1.5 text-xs text-slate-800 ring-1 ring-slate-200 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="busy"
        @click="emit('cancel-device-auth')"
      >
        Cancel sign-in
      </button>
      <button
        class="rounded-md bg-white px-3 py-1.5 text-xs text-slate-800 ring-1 ring-slate-200 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="busy || authFlowActive"
        @click="emit('logout')"
      >
        Log out
      </button>
    </div>

    <div class="mt-3 flex flex-col gap-2">
      <div class="text-[11px] text-slate-500">
        <template v-if="webAuthSupported">
          Rootgrid uses Codex device auth for ChatGPT sign-in. Start it here, then finish the browser flow. You can still use <span class="font-mono text-slate-700">codex login</span> or <span class="font-mono text-slate-700">codex login --device-auth</span> on the runner shell if needed.
        </template>
        <template v-else>
          {{ supportMessage || 'This runner is too old for Rootgrid-managed Codex sign-in. Update the runner or reauthenticate from the runner shell.' }}
        </template>
      </div>
      <div v-if="authFlow?.verificationUrl" class="rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-700">
        Open:
        <a
          class="ml-1 break-all text-indigo-700 hover:text-indigo-600 hover:underline"
          :href="authFlow.verificationUrl"
          target="_blank"
          rel="noreferrer"
        >
          {{ authFlow.verificationUrl }}
        </a>
      </div>
      <div v-if="authFlow?.userCode" class="rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-700">
        Code:
        <span class="ml-1 font-mono text-slate-900">{{ authFlow.userCode }}</span>
      </div>
      <div
        v-if="authFlow?.output"
        class="max-h-40 overflow-auto rounded-lg bg-slate-950 px-3 py-3 text-[11px] text-slate-100"
      >
        <code class="font-mono whitespace-pre-wrap break-words">{{ authFlow.output }}</code>
      </div>
    </div>

    <div v-if="authErrorText" class="mt-2 text-xs text-red-600">
      {{ authErrorText }}
    </div>
    <div v-else-if="authStatusText" class="mt-2 text-xs text-emerald-700">
      {{ authStatusText }}
    </div>
  </div>
</template>
