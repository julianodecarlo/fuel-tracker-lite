/** Configuração do Tailwind (v3). Equivale ao antigo bloco `tailwind.config` inline do index.html. */
module.exports = {
  content: ['./index.html', './app.js', './core.js'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        darkBg: '#0f172a',
        cardBg: '#1e293b',
        cardHover: '#334155',
        accentGreen: '#10b981',
        accentGreenDark: '#059669',
        accentBlue: '#3b82f6',
        accentOrange: '#f97316',
        accentPurple: '#8b5cf6',
        textMuted: '#94a3b8'
      }
    }
  }
};
