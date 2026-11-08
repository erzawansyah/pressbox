// Mobile navigation toggle.
document.addEventListener('DOMContentLoaded', () => {
    const navigation = document.getElementById('primary-navigation')
    const toggle = document.getElementById('primary-menu-toggle')
    if (!navigation || !toggle) return

    toggle.addEventListener('click', () => {
        const open = !navigation.classList.toggle('hidden')
        toggle.setAttribute('aria-expanded', String(open))
    })
})
