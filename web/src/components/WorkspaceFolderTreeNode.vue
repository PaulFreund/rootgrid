<script setup>
import { computed } from 'vue'
import { ChevronRight, FolderClosed } from 'lucide-vue-next'

defineOptions({
  name: 'WorkspaceFolderTreeNode'
})

const props = defineProps({
  entry: {
    type: Object,
    required: true
  },
  depth: {
    type: Number,
    default: 0
  },
  selectedPath: {
    type: String,
    default: ''
  },
  expandedDirs: {
    type: Object,
    required: true
  },
  loadingDirs: {
    type: Object,
    required: true
  },
  directoryEntries: {
    type: Object,
    required: true
  }
})

const emit = defineEmits(['toggle-dir', 'select-dir'])

const isExpanded = computed(() => props.expandedDirs?.has?.(props.entry.path))
const isLoading = computed(() => props.loadingDirs?.has?.(props.entry.path))
const children = computed(() => props.directoryEntries?.get?.(props.entry.path) ?? [])
const isSelected = computed(() => String(props.selectedPath ?? '') === String(props.entry?.path ?? ''))

function toggleDir() {
  emit('toggle-dir', props.entry.path)
}

function selectDir() {
  emit('select-dir', props.entry.path)
}
</script>

<template>
  <div>
    <div
      class="flex items-center gap-1 rounded-lg px-2 py-1.5"
      :style="{ paddingLeft: `${8 + (depth * 14)}px` }"
      :data-folder-path="entry.path"
    >
      <button
        class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-black/[0.04] hover:text-slate-600"
        type="button"
        :title="isExpanded ? 'Collapse folder' : 'Expand folder'"
        @click.stop="toggleDir"
      >
        <ChevronRight class="h-3.5 w-3.5 transition-transform" :class="isExpanded ? 'rotate-90' : ''" />
      </button>
      <button
        class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 text-left text-sm transition-colors hover:bg-black/[0.035]"
        :class="isSelected ? 'bg-black/[0.05]' : ''"
        type="button"
        @click="selectDir"
      >
        <FolderClosed class="h-4 w-4 shrink-0 text-slate-400" />
        <span class="min-w-0 flex-1 truncate text-slate-700">{{ entry.name }}</span>
      </button>
    </div>

    <div v-if="isExpanded">
      <div
        v-if="isLoading"
        class="px-2 py-1 text-xs text-slate-400"
        :style="{ paddingLeft: `${38 + (depth * 14)}px` }"
      >
        Loading…
      </div>
      <WorkspaceFolderTreeNode
        v-for="child in children"
        :key="child.path"
        :entry="child"
        :depth="depth + 1"
        :selected-path="selectedPath"
        :expanded-dirs="expandedDirs"
        :loading-dirs="loadingDirs"
        :directory-entries="directoryEntries"
        @toggle-dir="$emit('toggle-dir', $event)"
        @select-dir="$emit('select-dir', $event)"
      />
    </div>
  </div>
</template>
