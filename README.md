# HAKO Labs — Minecraft Bedrock Add-Ons

Laboratorio publico de Add-Ons Bedrock analisados, reproduziveis e reversiveis.

## Downloads

- **HAKO Agent**: Add-On proprio. O arquivo `.mcpack` fica em cada [GitHub Release](../../releases/latest).
- **[Why Not] Chop Chop — HAKO profile**: aprimoramento reprodutivel do Add-On de
  `daniswastaken`. Como o pacote recebido nao inclui uma licenca de redistribuicao,
  este repositorio publica a receita, hashes e validacoes, mas nao republica o binario
  nem o codigo do autor. Obtenha o original na pagina do autor e aplique a receita no
  painel HAKO Mine.

## O que “HAKO Labs” significa

HAKO Labs nao substitui a autoria original. E um perfil de verificacao e aprimoramento:

1. preserva o arquivo recebido e registra seu SHA-256;
2. analisa manifestos, dependencias e Script API;
3. produz uma copia separada quando uma transformacao formal conhecida e aplicavel;
4. valida estrutura e inicializacao;
5. exige teste de gameplay antes de declarar o Add-On homologado;
6. mantem backup e rollback.

Consulte [POLICY.md](POLICY.md) antes de enviar um Add-On de terceiros.

## Compilar o HAKO Agent

Requer Python 3.11 ou posterior:

```bash
python tools/build_hako_agent.py dist/hako-agent-1.0.1.mcpack
```

O build e deterministico: a mesma fonte produz o mesmo SHA-256.

## Seguranca e privacidade

Este repositorio nao contem mundos, jogadores, enderecos de servidor, credenciais,
backups ou configuracoes privadas. Relate vulnerabilidades conforme [SECURITY.md](SECURITY.md).

Minecraft e marca da Microsoft/Mojang. Este projeto nao e afiliado nem endossado por elas.
