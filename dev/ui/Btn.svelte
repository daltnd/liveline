<script lang="ts">
  import type { Snippet } from 'svelte'

  let { active, onclick, children }: {
    active: boolean
    onclick: () => void
    children: Snippet
  } = $props()
</script>

<button
  {onclick}
  style="font-size:11px; padding:4px 10px; border-radius:5px; border:1px solid {active ? 'rgba(59,130,246,0.5)' : 'var(--fg-08)'}; background:{active ? 'rgba(59,130,246,0.12)' : 'var(--fg-02)'}; color:{active ? '#3b82f6' : 'var(--fg-45)'}; cursor:pointer; font-family:system-ui, -apple-system, sans-serif; transition:all 0.15s;"
>
  {@render children()}
</button>
