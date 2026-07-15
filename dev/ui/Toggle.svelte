<script lang="ts">
  import type { Snippet } from 'svelte'

  let { on, onToggle, children }: {
    on: boolean
    onToggle: (v: boolean) => void
    children: Snippet
  } = $props()
</script>

<button
  onclick={() => onToggle(!on)}
  style="font-size:11px; padding:4px 10px; border-radius:5px; border:1px solid {on ? 'rgba(59,130,246,0.4)' : 'var(--fg-06)'}; background:{on ? 'rgba(59,130,246,0.1)' : 'transparent'}; color:{on ? '#3b82f6' : 'var(--fg-35)'}; cursor:pointer; font-family:system-ui, -apple-system, sans-serif; transition:all 0.15s;"
>
  {@render children()}
</button>
