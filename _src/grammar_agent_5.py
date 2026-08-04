# -*- coding: utf-8 -*-

import asyncio
import base64
import json
import os
import random
import sys
import pyaudio
import websockets
import dotenv
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.text import Text
from openai import OpenAI

dotenv.load_dotenv()

# ──────────────────────────────────────────────
#  Audio config
# ──────────────────────────────────────────────
FORMAT           = pyaudio.paInt16
CHANNELS         = 1
SAMPLE_RATE      = 24_000
CHUNK_SIZE       = 1_024
VOLUME_THRESHOLD = 300

# ──────────────────────────────────────────────
#  OpenAI config
#  Set OPENAI_API_KEY in a .env file or as an environment variable
# ──────────────────────────────────────────────
REALTIME_URL     = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview"
OPENAI_API_KEY   = os.environ.get("OPENAI_API_KEY", "")
CORRECTION_MODEL = "gpt-4o"
EVALUATION_MODEL = "gpt-4o"

MAX_CORRECTION_STAGES = 3   # ask to repeat → suggest alternatives → give answer


# ══════════════════════════════════════════════
#  Built-in Exercises (from course material)
# ══════════════════════════════════════════════
BUILTIN_EXERCISES = [
    # ── Exercise A: Des sorties (il y a + passé composé) ──
    {
        "exercise_title": "A. Des sorties",
        "exercise_type": "il_y_a",
        "grammar_targets": [
            "expression 'il y a' + durée",
            "passé composé avec être (verbes de mouvement)",
            "accord du participe passé avec le sujet"
        ],
        "context_description_fr":
            "Dites où et quand ces personnes sont allées en vacances. "
            "Utilisez l'expression 'il y a'.",
        "context_description_en":
            "Say where and when these people went on vacation using "
            "the expression 'il y a'.",
        "modele": {
            "prompt": "une semaine / Nora / la Côte d'Azur",
            "expected_answer":
                "Il y a une semaine, Nora est allée à la Côte d'Azur."
        },
        "items": [
            {
                "prompt": "un mois / Fabrice / plage",
                "expected_answer":
                    "Il y a un mois, Fabrice est allé à la plage.",
                "grammar_focus":
                    "il y a + passé composé être, masculin singulier"
            },
            {
                "prompt": "deux jours / tu / forêt / faire du camping",
                "expected_answer":
                    "Il y a deux jours, tu es allé(e) en forêt faire du camping.",
                "grammar_focus":
                    "il y a + passé composé être, accord selon le genre"
            },
            {
                "prompt": "six mois / Mme Robert / montagne / faire du ski",
                "expected_answer":
                    "Il y a six mois, Mme Robert est allée à la montagne "
                    "faire du ski.",
                "grammar_focus":
                    "il y a + passé composé être, féminin singulier"
            },
            {
                "prompt": "trois jours / nous / campagne",
                "expected_answer":
                    "Il y a trois jours, nous sommes allés à la campagne.",
                "grammar_focus":
                    "il y a + passé composé être, première personne pluriel"
            },
            {
                "prompt": "deux ans / je / Nice",
                "expected_answer":
                    "Il y a deux ans, je suis allé(e) à Nice.",
                "grammar_focus":
                    "il y a + passé composé être, première personne singulier"
            },
        ],
        "new_items": [
            {
                "prompt": "trois semaines / Sophie / Marseille",
                "expected_answer":
                    "Il y a trois semaines, Sophie est allée à Marseille.",
                "grammar_focus":
                    "il y a + passé composé être, féminin singulier"
            },
            {
                "prompt": "un an / mes parents / Japon",
                "expected_answer":
                    "Il y a un an, mes parents sont allés au Japon.",
                "grammar_focus":
                    "il y a + passé composé être, masculin pluriel, "
                    "préposition 'au'"
            },
            {
                "prompt": "cinq jours / vous / lac / faire de la natation",
                "expected_answer":
                    "Il y a cinq jours, vous êtes allé(e)(s) au lac "
                    "faire de la natation.",
                "grammar_focus":
                    "il y a + passé composé être, forme 'vous'"
            },
            {
                "prompt": "quatre mois / Marie et Claire / Espagne",
                "expected_answer":
                    "Il y a quatre mois, Marie et Claire sont allées "
                    "en Espagne.",
                "grammar_focus":
                    "il y a + passé composé être, féminin pluriel, "
                    "préposition 'en'"
            },
            {
                "prompt": "dix jours / Luc / île de la Réunion",
                "expected_answer":
                    "Il y a dix jours, Luc est allé à l'île de la Réunion.",
                "grammar_focus":
                    "il y a + passé composé être, masculin singulier"
            },
        ],
        "pronunciation_targets": [
            "il y a — liaison [i.lja]",
            "est allé(e) — le son [e] final",
            "sommes allés — liaison [sɔ.mz‿a.le]"
        ],
        "background_notes":
            "L'expression 'il y a' + durée indique un moment dans le passé. "
            "Structure : Il y a + durée, sujet + passé composé. "
            "Les verbes de mouvement (aller, venir, partir, arriver, etc.) "
            "se conjuguent avec 'être' au passé composé. "
            "Le participe passé s'accorde avec le sujet en genre et nombre."
    },

    # ── Exercise C: La curiosité (venir de + infinitif) ──
    {
        "exercise_title": "C. La curiosité",
        "exercise_type": "venir_de",
        "grammar_targets": [
            "passé récent : venir de + infinitif",
            "conjugaison de 'venir' au présent",
            "choix du verbe infinitif approprié"
        ],
        "context_description_fr":
            "Imaginez ce que ces personnes viennent de faire. "
            "Donnez trois possibilités pour chaque phrase.",
        "context_description_en":
            "Imagine what these people have just done. "
            "Give three possibilities for each sentence.",
        "modele": {
            "prompt": "Albert rentre du Sénégal.",
            "expected_answer":
                "Il vient de visiter l'Île de Gorée. "
                "Il vient de passer une semaine au soleil. "
                "Il vient de faire un safari."
        },
        "items": [
            {
                "prompt": "Jennifer part en vacances.",
                "expected_answer":
                    "Elle vient de réserver un billet d'avion. "
                    "Elle vient de faire ses valises. "
                    "Elle vient de demander un congé à son patron.",
                "grammar_focus":
                    "venir de + infinitif, 3e personne féminin singulier"
            },
            {
                "prompt": "Je sors du magasin de sport.",
                "expected_answer":
                    "Je viens d'acheter des chaussures de sport. "
                    "Je viens d'essayer un nouveau vélo. "
                    "Je viens de regarder les maillots de bain.",
                "grammar_focus":
                    "venir de + infinitif, 1re personne singulier"
            },
            {
                "prompt": "Nous revenons de la montagne.",
                "expected_answer":
                    "Nous venons de faire du ski. "
                    "Nous venons de faire une randonnée. "
                    "Nous venons de passer un week-end au chalet.",
                "grammar_focus":
                    "venir de + infinitif, 1re personne pluriel"
            },
            {
                "prompt":
                    "Anthony et Yvon reviennent de la campagne.",
                "expected_answer":
                    "Ils viennent de faire du vélo. "
                    "Ils viennent de visiter une ferme. "
                    "Ils viennent de pique-niquer au bord d'une rivière.",
                "grammar_focus":
                    "venir de + infinitif, 3e personne masculin pluriel"
            },
            {
                "prompt": "Aïcha rentre du Canada.",
                "expected_answer":
                    "Elle vient de visiter Montréal. "
                    "Elle vient de voir les chutes du Niagara. "
                    "Elle vient de goûter la poutine.",
                "grammar_focus":
                    "venir de + infinitif, 3e personne féminin singulier"
            },
        ],
        "new_items": [
            {
                "prompt": "Tu reviens du cinéma.",
                "expected_answer":
                    "Tu viens de voir un film d'action. "
                    "Tu viens de manger du pop-corn. "
                    "Tu viens de retrouver tes amis.",
                "grammar_focus":
                    "venir de + infinitif, 2e personne singulier"
            },
            {
                "prompt": "Vous sortez du restaurant.",
                "expected_answer":
                    "Vous venez de dîner avec des collègues. "
                    "Vous venez de goûter un plat nouveau. "
                    "Vous venez de fêter un anniversaire.",
                "grammar_focus":
                    "venir de + infinitif, 2e personne pluriel / forme polie"
            },
            {
                "prompt": "Marie et Julie rentrent de la bibliothèque.",
                "expected_answer":
                    "Elles viennent d'étudier pour un examen. "
                    "Elles viennent d'emprunter des livres. "
                    "Elles viennent de travailler sur un projet.",
                "grammar_focus":
                    "venir de + infinitif, 3e personne féminin pluriel"
            },
            {
                "prompt": "Mon frère revient du stade.",
                "expected_answer":
                    "Il vient de jouer au football. "
                    "Il vient de regarder un match. "
                    "Il vient de courir cinq kilomètres.",
                "grammar_focus":
                    "venir de + infinitif, 3e personne masculin singulier"
            },
            {
                "prompt": "Nous sortons de la boulangerie.",
                "expected_answer":
                    "Nous venons d'acheter du pain. "
                    "Nous venons de commander un gâteau. "
                    "Nous venons de prendre des croissants.",
                "grammar_focus":
                    "venir de + infinitif, 1re personne pluriel"
            },
        ],
        "pronunciation_targets": [
            "vient de — le son nasal [vjɛ̃]",
            "viennent — le son [vjɛn]",
            "venons — le son [vənɔ̃]",
            "d'acheter — élision obligatoire devant voyelle"
        ],
        "background_notes":
            "Le passé récent se forme avec 'venir de' + infinitif. "
            "Conjugaison de 'venir' au présent : je viens, tu viens, "
            "il/elle vient, nous venons, vous venez, ils/elles viennent. "
            "On utilise 'de' devant une consonne et 'd'' devant une voyelle "
            "ou un h muet."
    },

    # ── Exercise E: Alice, la curieuse (passé composé négatif) ──
    {
        "exercise_title": "E. Alice, la curieuse",
        "exercise_type": "passé_composé_negative",
        "grammar_targets": [
            "passé composé à la forme négative (ne...pas)",
            "passé composé avec être (verbes de mouvement)",
            "accord du participe passé avec le sujet",
            "négation ne...jamais"
        ],
        "context_description_fr":
            "Alice vous pose des questions sur les activités de vos amis. "
            "Répondez à la forme négative.",
        "context_description_en":
            "Alice asks you questions about your friends' activities. "
            "Answer in the negative form.",
        "modele": {
            "prompt":
                "Est-ce que Marianne est allée au cinéma ?",
            "expected_answer":
                "Non, Marianne n'est pas allée au cinéma."
        },
        "items": [
            {
                "prompt":
                    "Marianne et ses amis, sont-ils partis en vacances "
                    "en train ?",
                "expected_answer":
                    "Non, ils ne sont pas partis en vacances en train.",
                "grammar_focus":
                    "passé composé négatif avec être, masculin pluriel"
            },
            {
                "prompt":
                    "Est-ce que Marianne est déjà montée dans un train ?",
                "expected_answer":
                    "Non, Marianne n'est jamais montée dans un train.",
                "grammar_focus":
                    "ne...jamais au passé composé, féminin singulier"
            },
            {
                "prompt":
                    "Est-ce que son train est arrivé à l'heure ?",
                "expected_answer":
                    "Non, son train n'est pas arrivé à l'heure.",
                "grammar_focus":
                    "passé composé négatif avec être, masculin singulier"
            },
            {
                "prompt": "Sont-ils restés longtemps en Espagne ?",
                "expected_answer":
                    "Non, ils ne sont pas restés longtemps en Espagne.",
                "grammar_focus":
                    "passé composé négatif avec être, masculin pluriel"
            },
            {
                "prompt": "Êtes-vous allé(e) en France récemment ?",
                "expected_answer":
                    "Non, je ne suis pas allé(e) en France récemment.",
                "grammar_focus":
                    "passé composé négatif avec être, accord selon le genre"
            },
            {
                "prompt": "Es-tu passé(e) par la Suisse ?",
                "expected_answer":
                    "Non, je ne suis pas passé(e) par la Suisse.",
                "grammar_focus":
                    "passé composé négatif avec être, 1re personne"
            },
            {
                "prompt": "Es-tu rentré(e) en bateau ?",
                "expected_answer":
                    "Non, je ne suis pas rentré(e) en bateau.",
                "grammar_focus":
                    "passé composé négatif avec être, 1re personne"
            },
            {
                "prompt":
                    "Adèle et Nina, sont-elles revenues à San Francisco "
                    "en septembre ?",
                "expected_answer":
                    "Non, elles ne sont pas revenues à San Francisco "
                    "en septembre.",
                "grammar_focus":
                    "passé composé négatif avec être, féminin pluriel"
            },
        ],
        "new_items": [
            {
                "prompt": "Est-ce que Paul est monté au sommet ?",
                "expected_answer":
                    "Non, Paul n'est pas monté au sommet.",
                "grammar_focus":
                    "passé composé négatif avec être, masculin singulier"
            },
            {
                "prompt":
                    "Les filles, sont-elles déjà sorties ce matin ?",
                "expected_answer":
                    "Non, elles ne sont pas encore sorties ce matin.",
                "grammar_focus":
                    "ne...pas encore, féminin pluriel"
            },
            {
                "prompt": "Es-tu déjà allé(e) au Japon ?",
                "expected_answer":
                    "Non, je ne suis jamais allé(e) au Japon.",
                "grammar_focus":
                    "ne...jamais au passé composé, 1re personne"
            },
            {
                "prompt":
                    "Est-ce que tes cousins sont venus à la fête ?",
                "expected_answer":
                    "Non, mes cousins ne sont pas venus à la fête.",
                "grammar_focus":
                    "passé composé négatif avec être, masculin pluriel"
            },
            {
                "prompt":
                    "Êtes-vous retournés à l'hôtel après le dîner ?",
                "expected_answer":
                    "Non, nous ne sommes pas retournés à l'hôtel "
                    "après le dîner.",
                "grammar_focus":
                    "passé composé négatif avec être, 1re personne pluriel"
            },
        ],
        "pronunciation_targets": [
            "ne...pas — le 'ne' est souvent omis à l'oral mais doit "
            "être prononcé dans cet exercice",
            "partis — le son [paʁti]",
            "revenues — le son [ʁəvəny]"
        ],
        "background_notes":
            "Au passé composé négatif avec être : "
            "sujet + ne + être conjugué + pas/jamais/plus + participe passé. "
            "Le participe passé s'accorde avec le sujet. "
            "'déjà' dans la question → 'jamais' ou 'pas encore' dans la "
            "réponse négative."
    },

    # ── Exercise F: Souvenirs de vacances (conversation ouverte) ──
    {
        "exercise_title": "F. Souvenirs de vacances",
        "exercise_type": "open_conversation",
        "grammar_targets": [
            "passé composé (être et avoir)",
            "accord du participe passé",
            "questions au passé composé (inversion, est-ce que)",
            "vocabulaire des vacances et voyages"
        ],
        "context_description_fr":
            "Décrivez les vacances de l'année passée. Le professeur pose "
            "des questions et l'élève répond en utilisant le passé composé.",
        "context_description_en":
            "Describe last year's vacation. The teacher asks questions and "
            "the student answers using the passé composé.",
        "modele": {
            "prompt": "Quand es-tu parti(e) en vacances ?",
            "expected_answer":
                "Je suis parti(e) en vacances en juillet."
        },
        "items": [
            {
                "prompt":
                    "Quand es-tu parti(e) ? Où es-tu allé(e) ? "
                    "Es-tu resté(e) aux États-Unis ou es-tu allé(e) "
                    "à l'étranger ? As-tu visité un endroit exotique ?",
                "expected_answer":
                    "Je suis parti(e) en août. Je suis allé(e) en Italie. "
                    "Je suis allé(e) à l'étranger. Oui, j'ai visité "
                    "la côte amalfitaine.",
                "grammar_focus":
                    "passé composé être + avoir, vocabulaire voyages"
            },
            {
                "prompt":
                    "Es-tu allé(e) voir l'endroit où tes parents sont nés ? "
                    "Où es-tu né(e) ?",
                "expected_answer":
                    "Non, je ne suis pas allé(e) voir cet endroit. "
                    "Je suis né(e) à New York.",
                "grammar_focus":
                    "passé composé être, forme négative, naître"
            },
            {
                "prompt":
                    "Qu'est-ce que tu as fait pendant les vacances ? "
                    "Est-ce que tu as rencontré des gens intéressants ?",
                "expected_answer":
                    "J'ai visité des musées et j'ai nagé dans la mer. "
                    "Oui, j'ai rencontré des gens très sympathiques.",
                "grammar_focus":
                    "passé composé avoir, vocabulaire activités"
            },
            {
                "prompt":
                    "Comment es-tu rentré(e) : en avion ou en voiture ? "
                    "Es-tu revenu(e) mort(e) de fatigue ?",
                "expected_answer":
                    "Je suis rentré(e) en avion. "
                    "Oui, je suis revenu(e) mort(e) de fatigue !",
                "grammar_focus":
                    "passé composé être, moyens de transport"
            },
            {
                "prompt":
                    "Est-ce que tu prépares déjà tes vacances de "
                    "l'année prochaine ?",
                "expected_answer":
                    "Oui, je prépare déjà mes vacances. "
                    "Je vais aller en Grèce.",
                "grammar_focus":
                    "présent, futur proche"
            },
        ],
        "new_items": [
            {
                "prompt":
                    "Avec qui es-tu parti(e) en vacances ?",
                "expected_answer":
                    "Je suis parti(e) avec ma famille / mes amis.",
                "grammar_focus":
                    "passé composé être, préposition 'avec'"
            },
            {
                "prompt":
                    "Qu'est-ce que tu as mangé de spécial pendant "
                    "tes vacances ?",
                "expected_answer":
                    "J'ai mangé des spécialités locales. "
                    "J'ai goûté la pizza napolitaine.",
                "grammar_focus":
                    "passé composé avoir, vocabulaire nourriture"
            },
            {
                "prompt":
                    "Est-ce que tu as pris beaucoup de photos ?",
                "expected_answer":
                    "Oui, j'ai pris beaucoup de photos. / "
                    "Non, je n'ai pas pris beaucoup de photos.",
                "grammar_focus":
                    "passé composé avoir, participe irrégulier 'pris'"
            },
        ],
        "pronunciation_targets": [
            "parti(e) — le son [paʁti]",
            "allé(e) — le son [ale]",
            "rencontré — le son [ʁɑ̃kɔ̃tʁe]"
        ],
        "background_notes":
            "Exercice de conversation libre au passé composé. "
            "L'élève doit formuler des phrases complètes. "
            "Verbes avec être : aller, venir, partir, arriver, rester, "
            "rentrer, revenir, naître, mourir, sortir, entrer, monter, "
            "descendre, tomber, passer (intransitif). "
            "Tous les autres verbes se conjuguent avec avoir."
    },

    # ── Exercise A (ch.2): Qu'est-ce qu'il faut ? ──
    {
        "exercise_title": "A. Qu'est-ce qu'il faut ?",
        "exercise_type": "il_faut",
        "grammar_targets": [
            "expression 'il faut' + infinitif",
            "expression 'il faut' + nom",
            "vocabulaire de la vie quotidienne"
        ],
        "context_description_fr":
            "Répondez aux questions en utilisant 'il faut' suivi d'un "
            "infinitif ou d'un nom.",
        "context_description_en":
            "Answer the questions using 'il faut' followed by an "
            "infinitive or a noun.",
        "modele": {
            "prompt": "Qu'est-ce qu'il faut pour passer une soirée "
                      "à la française ?",
            "expected_answer":
                "Il faut des amis. Il faut aimer la bonne cuisine. "
                "Il faut prendre son temps."
        },
        "items": [
            {
                "prompt":
                    "Qu'est-ce qu'il faut pour passer des vacances "
                    "parfaites ?",
                "expected_answer":
                    "Il faut du soleil. Il faut choisir une bonne "
                    "destination. Il faut se reposer.",
                "grammar_focus":
                    "il faut + nom / il faut + infinitif"
            },
            {
                "prompt":
                    "Qu'est-ce qu'il faut pour fêter son anniversaire ?",
                "expected_answer":
                    "Il faut un gâteau. Il faut inviter ses amis. "
                    "Il faut de la musique.",
                "grammar_focus":
                    "il faut + nom / il faut + infinitif"
            },
            {
                "prompt":
                    "Qu'est-ce qu'il faut pour s'amuser dans une soirée "
                    "à l'américaine ?",
                "expected_answer":
                    "Il faut de la musique. Il faut danser. "
                    "Il faut des boissons.",
                "grammar_focus":
                    "il faut + nom / il faut + infinitif"
            },
            {
                "prompt":
                    "Qu'est-ce qu'il faut pour se faire une bonne bouffe ?",
                "expected_answer":
                    "Il faut de bons ingrédients. Il faut savoir cuisiner. "
                    "Il faut du temps.",
                "grammar_focus":
                    "il faut + nom / il faut + infinitif"
            },
            {
                "prompt":
                    "Qu'est-ce qu'il faut pour ne pas grossir ?",
                "expected_answer":
                    "Il faut manger équilibré. Il faut faire du sport. "
                    "Il faut éviter le sucre.",
                "grammar_focus":
                    "il faut + infinitif, infinitif négatif"
            },
            {
                "prompt":
                    "Qu'est-ce qu'il faut pour être en bonne santé ?",
                "expected_answer":
                    "Il faut dormir huit heures. Il faut manger des "
                    "légumes. Il faut faire de l'exercice.",
                "grammar_focus":
                    "il faut + infinitif, vocabulaire santé"
            },
            {
                "prompt":
                    "Qu'est-ce qu'il faut pour bien dormir ?",
                "expected_answer":
                    "Il faut un bon lit. Il faut éteindre les écrans. "
                    "Il faut se détendre avant de dormir.",
                "grammar_focus":
                    "il faut + nom / il faut + infinitif"
            },
        ],
        "new_items": [
            {
                "prompt":
                    "Qu'est-ce qu'il faut pour apprendre le français ?",
                "expected_answer":
                    "Il faut de la patience. Il faut pratiquer tous les "
                    "jours. Il faut écouter de la musique française.",
                "grammar_focus":
                    "il faut + nom / il faut + infinitif"
            },
            {
                "prompt":
                    "Qu'est-ce qu'il faut pour réussir un examen ?",
                "expected_answer":
                    "Il faut étudier. Il faut bien dormir la veille. "
                    "Il faut de la concentration.",
                "grammar_focus":
                    "il faut + infinitif / il faut + nom"
            },
            {
                "prompt":
                    "Qu'est-ce qu'il faut pour faire un bon voyage ?",
                "expected_answer":
                    "Il faut un passeport. Il faut réserver un hôtel. "
                    "Il faut planifier l'itinéraire.",
                "grammar_focus":
                    "il faut + nom / il faut + infinitif"
            },
            {
                "prompt":
                    "Qu'est-ce qu'il faut pour se faire des amis ?",
                "expected_answer":
                    "Il faut être ouvert. Il faut sortir souvent. "
                    "Il faut de la gentillesse.",
                "grammar_focus":
                    "il faut + infinitif / il faut + nom"
            },
        ],
        "pronunciation_targets": [
            "il faut — le son [il fo]",
            "il faut + voyelle — pas de liaison",
            "infinitifs en -er : le son [e] final"
        ],
        "background_notes":
            "'Il faut' est une expression impersonnelle qui exprime "
            "la nécessité ou l'obligation. "
            "Deux constructions possibles : "
            "1) il faut + infinitif (il faut manger) "
            "2) il faut + nom (il faut du courage). "
            "On utilise souvent l'article partitif (du, de la, des) "
            "avec les noms."
    },
]


# ──────────────────────────────────────────────
#  Conversation Agent system prompt template
# ──────────────────────────────────────────────
CONVERSATION_SYSTEM_PROMPT_TEMPLATE = """
Tu es un professeur de français qui fait pratiquer la grammaire à un élève par des
exercices structurés à l'oral.

**EXERCICE EN COURS:**
Titre : {exercise_title}
Type : {exercise_type}
Contexte : {context_description_fr}
Points de grammaire ciblés : {grammar_targets}
Notes : {background_notes}

**MODÈLE DE L'EXERCICE:**
Consigne : {modele_prompt}
Réponse attendue : {modele_answer}

**ÉLÉMENTS DE L'EXERCICE (dans l'ordre):**
{items_formatted}

**TON RÔLE:**
- Parle UNIQUEMENT en français, tout le temps — jamais en anglais.
- Garde tes réponses COURTES : 1 à 3 phrases maximum par tour.
- Tu guides l'élève à travers chaque élément de l'exercice, un par un.
- Insiste sur la prononciation correcte, surtout des formes grammaticales ciblées.

**DÉBUT DE SESSION:**
1. Salue brièvement l'élève.
2. Explique le contexte de l'exercice en 1-2 phrases simples.
3. Donne le MODÈLE : lis la consigne et la réponse attendue.
4. Puis passe au premier élément en donnant la consigne.

**STRATÉGIE DE CORRECTION (RESPECTE CET ORDRE STRICT):**

Étape 1 — DEMANDER DE RÉPÉTER :
Si la réponse de l'élève est grammaticalement incorrecte, incomplète, ou incompréhensible,
demande-lui de répéter en soulignant le mot/la forme incorrecte.
Exemples :
- "Attention, c'est 'dormis' ? Essayez encore."
- "Presque ! Réfléchissez à la conjugaison du verbe. Essayez encore."
- "Attention à la forme du verbe. Répétez, s'il vous plaît."

Étape 2 — PROPOSER DES ALTERNATIVES :
Si après la répétition, la réponse est toujours incorrecte, propose 2-3 alternatives
et demande à l'élève de choisir la bonne.
Exemples :
- "C'est 'dors' ou 'dormis' ?"
- "On dit 'Faites attention' ou 'Faisez attention' ?"
- "Est-ce qu'on utilise 'à', 'de' ou 'en' ici ?"

Étape 3 — DONNER LA RÉPONSE :
Seulement si les étapes 1 et 2 ont échoué, donne la bonne réponse et demande à
l'élève de la répéter après toi.
Exemples :
- "La bonne réponse est : 'Faites attention aux clients !' Répétez après moi."
- "On dit : 'Il y a un mois, Fabrice est allé à la plage.' Répétez, s'il vous plaît."

**APRÈS UNE RÉPONSE CORRECTE:**
- Confirme brièvement : "Très bien !", "Parfait !", "Excellent !"
- Si la prononciation n'est pas parfaite, modèle la forme correcte naturellement.
- Passe immédiatement à l'élément suivant.

**CORRECTION DE LA PRONONCIATION:**
- Insiste sur la prononciation des formes grammaticales ciblées.
- Si la transcription suggère une mauvaise prononciation, modèle la prononciation correcte.
- "Attention à la prononciation : on dit '[forme correcte]'."

**IMPOSITION DU FRANÇAIS:**
- Si l'élève parle en anglais ou dans une autre langue, réponds en français :
  "S'il vous plaît, répondez en français !" puis répète la consigne.

**PROGRESSION:**
- Travaille sur chaque élément dans l'ordre.
- Quand tous les éléments originaux sont terminés, passe aux éléments supplémentaires.
- Après le dernier élément, félicite l'élève et demande s'il veut continuer avec
  un autre exercice ou terminer.

**SUIVI INTERNE:**
- Garde en mémoire l'élément en cours (numéro).
- Garde en mémoire le stade de correction (étape 1, 2 ou 3) pour l'élément en cours.
- Réinitialise le stade de correction quand tu passes à un nouvel élément.

**CONTRÔLE DE SESSION:**
- Si l'élève dit "pause" ou "une pause" → accuse réception et attends.
- Si l'élève dit "continuer" ou "on continue" → reprends la session.
- Si l'élève dit "terminer" ou "fin" → dis au revoir chaleureusement en français,
  puis émets le token exact [SESSION_END].
""".strip()

# ──────────────────────────────────────────────
#  Correction Agent prompt
# ──────────────────────────────────────────────
CORRECTION_PROMPT_TEMPLATE = """
Tu es un correcteur expert en langue française, spécialisé dans la grammaire
(temps, conjugaisons, prépositions, accords) pour les élèves de niveau A1-A2.

Analyse l'énoncé de l'élève ci-dessous dans le cadre d'un exercice de grammaire.
L'exercice porte sur : {grammar_targets}
La réponse attendue (ou une réponse similaire acceptable) est : {expected_answer}

Réponds UNIQUEMENT avec un objet JSON (sans balises markdown) correspondant
exactement à ce schéma :

{{
  "has_errors": true | false,
  "corrected": "<phrase française corrigée, ou chaîne vide si pas d'erreurs>",
  "error_stage": "repeat | suggest_alternatives | give_answer",
  "errors": [
    {{
      "type": "conjugation | tense | agreement | preposition | word_order | vocabulary | pronunciation_note | missing_word | extra_word",
      "original": "<le fragment problématique>",
      "correction": "<la forme correcte>",
      "explanation": "<explication concise en anglais, 20 mots max>",
      "phonetic_hint": "<guide phonétique optionnel pour les erreurs de prononciation>"
    }}
  ],
  "grammar_score": 0-5,
  "pronunciation_focus": "<un point clé de prononciation à travailler, ou chaîne vide>",
  "encouragement": "<une courte phrase d'encouragement en anglais>"
}}

Porte une attention particulière à :
- Conjugaison correcte (temps, personne, mode)
- Accord du participe passé (genre, nombre)
- Prépositions (à, de, en, au, aux, du, des)
- Accord des adjectifs
- Négation (ne...pas, ne...jamais, ne...plus, ne...rien)
- Structure de la phrase

Pour "error_stage":
- "repeat" si les erreurs sont mineures et l'élève peut se corriger seul
- "suggest_alternatives" si les erreurs sont plus importantes
- "give_answer" si la réponse est très éloignée de l'attendu

Énoncé de l'élève (en français) : {utterance}
""".strip()

# ──────────────────────────────────────────────
#  Evaluation Agent prompt
# ──────────────────────────────────────────────
EVALUATION_PROMPT_TEMPLATE = """
You are a French language assessor evaluating a grammar practice session.
Based on the full session transcript below, write a concise performance report in English.

The exercises focused on: {grammar_targets}

Structure it as markdown with these sections:

## Session Summary
## Grammar Performance 📝
  - Accuracy by grammar point
  - Common error patterns
## Conjugation & Tense Usage 🔤
## Agreement & Prepositions 🎯
## Pronunciation Notes 🎤
## Correction Response
  - How well the student responded to corrections
  - Number of self-corrections vs. guided corrections
## Strengths 💪
## Areas to Improve 📝
## Recommended Practice
## Overall Score  (format: X / 10)

Transcript:
{transcript}
""".strip()


# ══════════════════════════════════════════════
#  Correction Agent
# ══════════════════════════════════════════════
async def run_correction_agent(client: OpenAI, utterance: str,
                                grammar_targets: str,
                                expected_answer: str) -> dict:
    prompt = CORRECTION_PROMPT_TEMPLATE.format(
        utterance=utterance,
        grammar_targets=grammar_targets,
        expected_answer=expected_answer,
    )

    def _call():
        resp = client.chat.completions.create(
            model=CORRECTION_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
        )
        raw = resp.choices[0].message.content.strip()
        if raw.startswith("```"):
            lines = raw.split("\n")
            raw = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
            if raw.startswith("json"):
                raw = raw[4:].strip()
        return json.loads(raw)

    return await asyncio.to_thread(_call)


# ══════════════════════════════════════════════
#  Evaluation Agent
# ══════════════════════════════════════════════
async def run_evaluation_agent(client: OpenAI, transcript: list,
                                grammar_targets: str) -> str:
    transcript_text = "\n".join(
        f"[{t['role'].upper()}] {t['text']}" for t in transcript
    )
    prompt = EVALUATION_PROMPT_TEMPLATE.format(
        transcript=transcript_text,
        grammar_targets=grammar_targets,
    )

    def _call():
        resp = client.chat.completions.create(
            model=EVALUATION_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
        )
        return resp.choices[0].message.content.strip()

    return await asyncio.to_thread(_call)


# ══════════════════════════════════════════════
#  Main Grammar Session
# ══════════════════════════════════════════════
class GrammarSession:

    def __init__(self, exercises: list):
        self.console    = Console()
        self.pya        = pyaudio.PyAudio()
        self.oai_client = OpenAI(api_key=OPENAI_API_KEY)
        self.exercises  = exercises

        self.current_exercise_idx = 0
        self.current_exercise     = exercises[0]

        self.audio_in_queue  = None
        self.audio_out_queue = None

        self.paused              = False
        self.session_ended       = False
        self.transcript          = []

        self.speaking            = False
        self.recording           = False
        self.assistant_speaking  = True
        self.audio_chunks_recorded = 0
        self.ws                  = None

        self.current_item_idx    = 0
        self.correction_stage    = 0
        self.repeat_requested    = False

        self._build_all_items()
        self.system_prompt       = self._build_system_prompt()
        self.grammar_targets_str = ", ".join(
            self.current_exercise.get("grammar_targets", [])
        )

    def _build_all_items(self):
        ex = self.current_exercise
        self.all_items = list(ex.get("items", []))
        self.all_items.extend(ex.get("new_items", []))

    def _get_current_expected_answer(self) -> str:
        if self.current_item_idx < len(self.all_items):
            return self.all_items[self.current_item_idx].get("expected_answer", "")
        return ""

    def _build_system_prompt(self) -> str:
        ex = self.current_exercise

        items_lines = []
        all_items = list(ex.get("items", []))
        all_items.extend(ex.get("new_items", []))

        for i, item in enumerate(all_items, 1):
            items_lines.append(
                f"{i}. Consigne : {item['prompt']}\n"
                f"   Réponse attendue : {item['expected_answer']}\n"
                f"   Point de grammaire : {item.get('grammar_focus', '')}"
            )

        grammar_targets = ", ".join(ex.get("grammar_targets", []))
        pronunciation_targets = ", ".join(ex.get("pronunciation_targets", []))

        modele = ex.get("modele", {})

        return CONVERSATION_SYSTEM_PROMPT_TEMPLATE.format(
            exercise_title=ex.get("exercise_title", "Exercice de grammaire"),
            exercise_type=ex.get("exercise_type", "grammar"),
            context_description_fr=ex.get("context_description_fr", ""),
            grammar_targets=grammar_targets,
            background_notes=ex.get("background_notes", "")
                + ("\nPrononciation : " + pronunciation_targets if pronunciation_targets else ""),
            modele_prompt=modele.get("prompt", ""),
            modele_answer=modele.get("expected_answer", ""),
            items_formatted="\n".join(items_lines),
        )

    async def _send(self, payload: dict):
        await self.ws.send(json.dumps(payload))

    async def _configure_session(self):
        await self._send({
            "type": "session.update",
            "session": {
                "modalities": ["text", "audio"],
                "instructions": self.system_prompt,
                "voice": "shimmer",
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "input_audio_transcription": {"model": "whisper-1", "language": "fr"},
                "turn_detection": None,
                "temperature": 0.8,
            },
        })
        self.console.print("[bold green]✅  Session configurée[/bold green]")

    async def _send_initial_message(self):
        await self._send({
            "type": "conversation.item.create",
            "item": {
                "type": "message",
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": "Bonjour ! Commencez la session de grammaire maintenant. "
                            "Présentez l'exercice et donnez le modèle.",
                }],
            },
        })
        await self._send({
            "type": "response.create",
            "response": {"modalities": ["text", "audio"]},
        })

    async def _listen_mic(self):
        mic_info = self.pya.get_default_input_device_info()
        stream = self.pya.open(
            format=FORMAT, channels=CHANNELS, rate=SAMPLE_RATE,
            input=True, input_device_index=mic_info["index"],
            frames_per_buffer=CHUNK_SIZE,
        )
        self.console.print("🎤  [yellow]Microphone prêt[/yellow]")

        while not self.session_ended:
            if self.paused:
                await asyncio.sleep(0.05)
                continue

            data = await asyncio.to_thread(
                stream.read, CHUNK_SIZE, exception_on_overflow=False
            )

            if not self.recording:
                continue

            self.audio_chunks_recorded += 1

            samples = [
                int.from_bytes(data[i:i + 2], "little", signed=True)
                for i in range(0, len(data), 2)
            ]
            volume = sum(abs(s) for s in samples) / len(samples)
            if volume > VOLUME_THRESHOLD:
                if not self.speaking:
                    self.console.print("\n🎙️  ", end="")
                    self.speaking = True
                self.console.print("▪", end="", style="green")
            else:
                if self.speaking:
                    self.speaking = False

            await self.audio_in_queue.put(data)

        stream.stop_stream()
        stream.close()

    async def _send_audio(self):
        while not self.session_ended:
            if self.paused:
                await asyncio.sleep(0.05)
                continue
            chunk = await self.audio_in_queue.get()
            await self._send({
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(chunk).decode(),
            })

    async def _play_audio(self):
        stream = self.pya.open(
            format=FORMAT, channels=CHANNELS, rate=SAMPLE_RATE,
            output=True, frames_per_buffer=CHUNK_SIZE,
        )
        while not self.session_ended:
            chunk = await self.audio_out_queue.get()
            if chunk is None:
                break
            await asyncio.to_thread(stream.write, chunk)

        stream.stop_stream()
        stream.close()

    async def _keyboard_control(self):
        while not self.session_ended:
            if self.paused:
                await asyncio.sleep(0.1)
                continue

            while self.assistant_speaking and not self.session_ended:
                await asyncio.sleep(0.1)

            if self.session_ended:
                break

            try:
                import termios
                termios.tcflush(sys.stdin, termios.TCIFLUSH)
            except Exception:
                pass

            self.console.print(
                "\n[bold cyan]🟢 Appuyez sur ENTRÉE pour parler...[/bold cyan]", end=""
            )
            try:
                await asyncio.to_thread(input)
            except EOFError:
                break

            if self.session_ended:
                break

            self.recording = True
            self.audio_chunks_recorded = 0
            self.console.print(
                "🔴 [bold red]Enregistrement... Appuyez sur ENTRÉE pour terminer.[/bold red]",
                end=""
            )
            try:
                await asyncio.to_thread(input)
            except EOFError:
                break

            self.recording = False

            if self.audio_chunks_recorded < 3:
                self.console.print("\n[yellow]⚠️  Trop court — réessayez.[/yellow]")
                continue

            self.console.print("\n⏳ [dim]Traitement…[/dim]")
            await self._send({"type": "input_audio_buffer.commit"})

            self.assistant_speaking = True

    async def _receive_events(self):
        tutor_text_buffer = []

        async for raw in self.ws:
            event = json.loads(raw)
            etype = event.get("type", "")

            if etype == "response.audio.delta":
                pcm = base64.b64decode(event["delta"])
                await self.audio_out_queue.put(pcm)

            elif etype == "conversation.item.input_audio_transcription.completed":
                utterance = event.get("transcript", "").strip()
                if utterance:
                    self.console.print(f"\n👤 [bold cyan]Élève:[/bold cyan] {utterance}")
                    self.transcript.append({"role": "student", "text": utterance})

                    lower = utterance.lower()
                    if any(w in lower for w in ["pause", "une pause", "arrêt"]):
                        self.paused = True
                        self.console.print(
                            "⏸️  [yellow]En pause. Dites 'continuer' pour reprendre.[/yellow]"
                        )
                    elif any(w in lower for w in ["continuer", "on continue", "reprendre"]) and self.paused:
                        self.paused = False
                        self.console.print("▶️  [green]Reprise.[/green]")

                    asyncio.ensure_future(
                        self._handle_correction_and_respond(utterance)
                    )

            elif etype == "response.audio_transcript.delta":
                tutor_text_buffer.append(event.get("delta", ""))

            elif etype == "response.done":
                if tutor_text_buffer:
                    tutor_text = "".join(tutor_text_buffer).strip()
                    tutor_text_buffer.clear()
                    self.transcript.append({"role": "tutor", "text": tutor_text})
                    self.console.print(
                        Panel(
                            Markdown(tutor_text),
                            title="🤖 Professeur",
                            border_style="blue",
                        )
                    )
                    if "[SESSION_END]" in tutor_text:
                        self.session_ended = True
                        await self.audio_out_queue.put(None)
                        await self._end_session()
                        return

                self.assistant_speaking = False

            elif etype == "error":
                self.console.print(f"[red]⚠️  API error: {event}[/red]")

    async def _handle_correction_and_respond(self, utterance: str):
        expected = self._get_current_expected_answer()

        try:
            result = await run_correction_agent(
                self.oai_client, utterance,
                self.grammar_targets_str, expected
            )
        except Exception as e:
            self.console.print(f"[red]Correction Agent error: {e}[/red]")
            result = {"has_errors": False, "encouragement": "Keep going!"}

        self._display_correction_panel(result)

        has_errors = result.get("has_errors", False)
        instruction = None

        if has_errors:
            self.correction_stage += 1

            corrected = result.get("corrected", "")
            errors_detail = "; ".join(
                "{}: '{}' → '{}'".format(
                    e["type"].replace("_", " "),
                    e["original"],
                    e["correction"],
                )
                for e in result.get("errors", [])
            )
            pron = result.get("pronunciation_focus", "")

            if self.correction_stage == 1:
                instruction = (
                    "[CORRECTION STAGE 1 - ASK TO REPEAT] "
                    "The student made errors. Errors: {}. "
                    "Ask the student to try again, focusing on the incorrect word(s). "
                    "Do NOT give the answer yet. Highlight what's wrong and encourage "
                    "them to self-correct. Example: 'Attention, c'est \"dormis\" ? "
                    "Réfléchissez à la conjugaison. Essayez encore.'"
                ).format(errors_detail)

            elif self.correction_stage == 2:
                instruction = (
                    "[CORRECTION STAGE 2 - SUGGEST ALTERNATIVES] "
                    "The student still has errors after retrying. Errors: {}. "
                    "The correct answer is: '{}'. "
                    "Now propose 2-3 alternatives (including the correct one) and "
                    "ask the student to choose. Example: \"C'est 'dors' ou 'dormis' ?\" "
                    "Do NOT give away which is correct — let them choose."
                ).format(errors_detail, corrected)

            else:
                instruction = (
                    "[CORRECTION STAGE 3 - GIVE ANSWER] "
                    "The student has failed twice. Give the correct answer now: '{}'. "
                    "Say it clearly and ask the student to repeat after you. "
                    "Example: 'La bonne réponse est : \"{}\". Répétez après moi.'{}"
                ).format(
                    corrected, corrected,
                    " Pronunciation focus: {}.".format(pron) if pron else ""
                )

        else:
            if self.correction_stage > 0:
                instruction = (
                    "[STUDENT CORRECTED SUCCESSFULLY] "
                    "The student got it right after correction. "
                    "Give brief praise and move to the next exercise item."
                )
            else:
                instruction = (
                    "[CORRECT ANSWER] "
                    "The student answered correctly on the first try. "
                    "Give brief praise and move to the next exercise item."
                )

            self.current_item_idx += 1
            self.correction_stage = 0

            if self.current_item_idx >= len(self.all_items):
                instruction += (
                    " All exercise items are completed! Congratulate the student "
                    "and ask if they want to continue with another exercise or end."
                )

        if instruction:
            await self._send({
                "type": "conversation.item.create",
                "item": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": instruction}],
                },
            })

        await self._send({
            "type": "response.create",
            "response": {"modalities": ["text", "audio"]},
        })

    def _display_correction_panel(self, result: dict):
        if not result.get("has_errors"):
            self.console.print(
                "  ✅ [green]{}[/green]".format(
                    result.get("encouragement", "Excellent français !")
                )
            )
            return

        lines = ["💬 **{}**\n".format(result.get("encouragement", ""))]
        if result.get("corrected"):
            lines.append("✏️  **Corrigé :** {}\n".format(result["corrected"]))

        for err in result.get("errors", []):
            line = "- **{}**: `{}` → `{}` — {}".format(
                err["type"].replace("_", " ").title(),
                err["original"],
                err["correction"],
                err["explanation"],
            )
            if err.get("phonetic_hint"):
                line += " *(prononciation : {})*".format(err["phonetic_hint"])
            lines.append(line)

        grammar_score = result.get("grammar_score", "")
        if grammar_score != "":
            lines.append("\n📊 **Score grammaire :** {} / 5".format(grammar_score))

        if result.get("pronunciation_focus"):
            lines.append("\n🔊 **Prononciation à travailler :** {}".format(
                result["pronunciation_focus"]
            ))

        stage_labels = {0: "Nouvel élément", 1: "Étape 1 — Répéter",
                        2: "Étape 2 — Alternatives", 3: "Étape 3 — Réponse donnée"}
        stage_label = stage_labels.get(
            self.correction_stage + 1, "Correction"
        )

        self.console.print(
            Panel(
                Markdown("\n".join(lines)),
                title="📝 Correction — {}".format(stage_label),
                border_style="yellow",
            )
        )

    async def _end_session(self):
        self.console.print(
            "\n[bold magenta]⏳  Génération du rapport de session…[/bold magenta]"
        )
        try:
            report = await run_evaluation_agent(
                self.oai_client, self.transcript, self.grammar_targets_str
            )
            self.console.print(
                Panel(
                    Markdown(report),
                    title="📊 Évaluation de la Session",
                    border_style="magenta",
                )
            )
        except Exception as e:
            self.console.print(f"[red]Evaluation Agent error: {e}[/red]")

    async def run(self):
        self.audio_in_queue  = asyncio.Queue()
        self.audio_out_queue = asyncio.Queue()

        headers = {
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "OpenAI-Beta": "realtime=v1",
        }

        self.console.print(
            Panel(
                Text(
                    "🇫🇷  Agent de Grammaire — Exercices Structurés en Français",
                    justify="center",
                ),
                border_style="green",
            )
        )
        self.console.print(
            "[dim]Commandes : [bold]'pause'[/bold] · [bold]'continuer'[/bold] · "
            "[bold]'terminer'[/bold][/dim]\n"
        )

        ex = self.current_exercise
        grammar_targets = ", ".join(ex.get("grammar_targets", []))
        num_items = len(self.all_items)
        modele = ex.get("modele", {})

        self.console.print(
            Panel(
                f"[bold]Exercice :[/bold] {ex.get('exercise_title', '')}\n"
                f"[bold]Type :[/bold] {ex.get('exercise_type', '')}\n"
                f"[bold]Grammaire ciblée :[/bold] {grammar_targets}\n"
                f"[bold]Contexte :[/bold] {ex.get('context_description_fr', '')}\n"
                f"[bold]Modèle :[/bold] {modele.get('prompt', '')} → {modele.get('expected_answer', '')}\n"
                f"[bold]Nombre d'éléments :[/bold] {num_items}",
                title="📖 Exercice chargé",
                border_style="cyan",
            )
        )

        async with websockets.connect(REALTIME_URL, additional_headers=headers) as ws:
            self.ws = ws
            await self._configure_session()
            await self._send_initial_message()

            tasks = [
                asyncio.ensure_future(self._listen_mic()),
                asyncio.ensure_future(self._send_audio()),
                asyncio.ensure_future(self._play_audio()),
                asyncio.ensure_future(self._receive_events()),
                asyncio.ensure_future(self._keyboard_control()),
            ]
            try:
                await asyncio.gather(*tasks)
            except Exception:
                for t in tasks:
                    t.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                raise

        self.console.print(
            "\n[bold green]👋  Au revoir ! Bonne continuation ![/bold green]"
        )
        self.pya.terminate()


# ══════════════════════════════════════════════
#  Entry point
# ══════════════════════════════════════════════
def main():
    console = Console()

    # ── Validate API key ───────────────────────
    if not OPENAI_API_KEY:
        console.print(
            "[red]❌  OPENAI_API_KEY non trouvée.[/red]\n"
            "[dim]Créez un fichier [bold].env[/bold] avec :[/dim]\n"
            "[bold yellow]OPENAI_API_KEY=sk-...[/bold yellow]"
        )
        sys.exit(1)

    # ── Randomly select an exercise ──────────────
    selected = random.choice(BUILTIN_EXERCISES)

    console.print(
        Panel(
            "Bienvenue dans l'Agent de Grammaire Française !\n\n"
            "Une session de pratique orale va commencer\n"
            "avec un exercice choisi au hasard.",
            title="🇫🇷  Agent de Grammaire",
            border_style="green",
        )
    )
    console.print(
        f"[bold green]🎲  Exercice sélectionné : {selected['exercise_title']}[/bold green]\n"
    )

    # ── Run grammar session ───────────────────
    session = GrammarSession([selected])
    try:
        asyncio.run(session.run())
    except KeyboardInterrupt:
        console.print("\n[yellow]Session interrompue.[/yellow]")
    except Exception:
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
