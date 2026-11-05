# Fuel Tracker — instruções para o Claude Code

Responda sempre em português do Brasil, de forma curta e direta.

## Economia de tokens
- Não leia arquivos grandes inteiros (`app.js` tem mais de 2.400 linhas e `index.html` cerca de 90 KB). Localize com Grep e leia só o trecho com offset/limit.
- Não releia um arquivo que acabou de editar. Agrupe edições do mesmo arquivo. Sem narração entre chamadas de ferramenta.
- Rode testes com saída curta: `npm test 2>&1 | tail -25`. Mostre só o resumo.
- Ignore `node_modules/`, `android/build/`, `www/` e `vendor/` em buscas.

## Autonomia
- Siga o `PLANO-PRODUCAO.md` sem pedir confirmação a cada passo.
- Pare e pergunte SOMENTE se: (a) a decisão não está coberta pelo plano; (b) for instalar pacote npm que o plano não cita; (c) envolver keystore, senhas ou chaves; (d) for fazer `git push`; (e) os testes continuarem falhando após 2 tentativas; (f) uma mudança puder apagar dados de usuários.

## Regras do projeto
- Não alterar o `applicationId` (`io.github.julianodecarlo.twa`).
- Nunca commitar segredos (`*.keystore`, `signing-key-info.txt`, `.env`). Nunca ler esses arquivos.
- `www/` é gerado por `npm run build:web`. Não editar à mão.
- Não iniciar a Fase 2 antes de a Fase 1 estar testada em aparelho real.
- Ao fim de cada tarefa do plano: rodar `npm test` e fazer commit **local** na branch atual com a mensagem `fase1: <tarefa>`. Nunca fazer push.
- Ao terminar, entregar um resumo de até 5 linhas: o que mudou, resultado dos testes e o que precisa ser testado em aparelho.
