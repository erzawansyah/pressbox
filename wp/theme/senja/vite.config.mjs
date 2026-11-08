import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

// Relative base: sandbox previews serve the site under a path prefix, so absolute
// /wp-content/... URLs inside the CSS would break there.
export default defineConfig({
    base: './',
    build: {
        manifest: true,
        outDir: 'dist',
        rollupOptions: {
            input: ['resources/js/app.js', 'resources/css/app.css', 'resources/css/editor-style.css'],
        },
    },
    plugins: [tailwindcss()],
})
