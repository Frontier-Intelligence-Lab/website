# Weight-space programming: what the sources support

Reading note for Valcairn, 6 November 2026. The 2 November 2026 blog is not peer reviewed. Every figure is **measured** (a page or file we opened), **author-claimed** (the authors' report; we did not re-run it), or **inference**. None of these figures is a product promise.

## Sources

Primary, read through the citation: Rikiya Takehi, Jayden Teoh, Alex Zhang, and Omar Khattab, each listed as MIT CSAIL, "Sparks of Weight-Space Programming," 2 November 2026. The log README was read; per-run JSON was not. The model card was read; its re-run was not repeated.

Follow-ups. Affiliations are from the papers.

- arXiv 2611.04268, Zhuoran Zheng (the page gives zhengzr@njust.edu.cn and no department line) and Doubao, 3 November 2026. HTML read through the conclusion. The manuscript says it is conjectural and reports no measurements.
- arXiv 2611.05341, Humza Nusrat (Radiation Oncology, Henry Ford Health; Radiology, Michigan State University) and Omar Nusrat (Toronto Metropolitan University), 3 November 2026. Methods and the flaw-panel table were read. The later results narrative, and the tail of the code README, were cut off in the fetch. Not re-run.
- arXiv 2611.07319, WeightLoop: Mengran Li and Zelin Zang (Hong Kong Institute of Science and Innovation), Bo Li and Weijing Zhao (University of Macau), Chengyang Zhang (Sichuan University), Boyu Zhang (Sun Yat-sen University), Jinfeng Xu and Victor C. M. Leung (University of British Columbia), Stan Z. Li (Westlake University), 5 November 2026. HTML read through the conclusion. Not re-run. Not MIT.
- arXiv 2611.08070, Nazmus Sakib Ahmed (BRAC University), 5 November 2026. HTML read through the CIFAR-10 controls and the start of the less-familiar datasets. Not re-run. Not MIT.

## What the editor is given

The blog's editor is a hosted frontier model. The log README names it OpenAI `gpt-6-astra` (**measured**). The README marks all 1,125 turns tool-free (**measured**). Allowed code is one Python block in their no-network sandbox (**measured**).

Supplies are **author-claimed**. Experiments 1, 2, 4, and 5 get weights as text and no forward pass; experiment 4 edits in one reply. Experiment 3 gets middle blocks and Python, and cannot run the network. Experiment 6 may read tensors with numpy or torch on CPU; running the network spends a pass (up to 128 rollouts, or outputs on up to 256 positions), with budgets 0, 10, 25, and 50. Experiment 7 gets two Gemma 3 270M copies with embeddings and the output layer frozen; weights alone failed four times, and a later tool returns attention maps only. Experiment 8 gets a Python kernel over Qwen3.5-0.8B, no GPU, GSM8K train (7,469) and MATH train (7,275), and 10, 25, or 50 passes (up to 512 answers or 1,024 texts). Scored benchmarks are outside that pool.

WeightLoop's GPT-6 Astra (**author-claimed**) sees the task and implementation once and writes a bounded program. Later updates do not call the model, and the permanent test set stays out of the edit's support (**author-claimed**). Ahmed gives Claude Opus 5.5 every weight as text, with no tools, no forward pass, and no dataset or class names (**author-claimed**). Nusrat gives that model the protocol and the weights, with no tools, data, or code (**author-claimed**). Zheng's statistics-and-slices sandbox was not run (**author-claimed** conjecture).

## Keep, revert, and the separate score

Experiment 6 keeps a change only when practice wins rise; scoring against unseen PPO seeds is separate (**author-claimed**). Experiment 8 practices on training splits and scores benchmarks the editor never sees (**author-claimed**). The model card says the checkpoint was sha256-checked (**measured**): only the two `down_proj` weights in layers 15 and 19 differ from `Qwen/Qwen3.5-0.8B` at revision `2fc06364715b967f1860aea9cf38778875588b17`. WeightLoop keeps an update only when support-validation allows it; otherwise the delta is zero (**author-claimed**). Nusrat tests every claim and repair on held-out requests (**author-claimed**).

**Inference:** the rule worth copying is propose, check on development data, keep or revert, and treat a separate frozen set as the only release score.

## What held on a separate evaluation

**Author-claimed** unless marked measured.

- Experiment 8 at 50 passes: MATH-500 7.9 to 48.1, GSM8K 13.8 to 67.1, IFEval 21.0 to 62.3, token-limit hits 93 to 33.1. At 10 and 25 passes, MATH-500 was 12.3 and 14.1. The edit is 131,072 weights, stated as 0.016 percent. The card's re-run reports MATH-500 51.0 and a 31.6 percent token-limit rate, plus a 25-problem base smoke of 5.0 (**measured** as card text). It used the multimodal checkpoint; the card says the language tensors were hash-checked.
- Gemma 3 270M: base MATH-500 6.8; after 5, 10, 25, and 50 passes, 7.0, 7.6, 7.7, and 7.0. The authors say this did not add a missing ability. The base rarely loops (8.5 percent hit the limit).
- Experiment 6: 0 passes wins more than half against two smaller PPO nets; 50 passes beats an equal-sized PPO trained on 20 million games, scored on games the editor does not play.
- Nusrat, networks of 433 to 4,801 parameters: the broken rule named in 16 of 18 flawed networks (Wilson 95 percent interval 67 to 97 percent), including all 15 confound or shift cases; those 16 repaired by a median of 3 parameters; 2 of 5 healthy networks cleared without forcing; 1 of 3 triggers found. A simple statistic found the same confound and shift flaws. The authors say this cannot certify a network.
- WeightLoop, scientific predictors, not language adapters: mean ranking utility improved in 7 of 8 settings and in all 8 against random edits; mean final discovery improved on three sequential tasks.
- Ahmed: local arithmetic checked out (about three optimizer steps; the CIFAR-10 vehicle/animal sign split). After label permutation the split stayed and the class names were wrong. Several partial-trace claims failed. Mostly single runs. Conclusion: zero-shot reading, for this model, is local arithmetic plus dataset priors.

## Stated limits

The blog calls the work early, limited by context and harnesses, with no standard benchmark yet (**author-claimed**). Removing an obstacle worked on Qwen; adding math to Gemma did not; the jump shows at 50 passes and barely at 10 or 25 (**author-claimed**). Weights alone missed the sycophant (**author-claimed**). Ahmed's other model shows the same weak reading (**author-claimed**). Nusrat's repairs match a simple statistic on tiny nets (**author-claimed**). Zheng is not evidence.

## LoRA adapters: what transfers, what is untested

**Inference.** No source tests PEFT, LoRA composition, or edits that touch only adapter matrices. The Qwen edit is on the full 0.8B checkpoint. The blog's open Python kernel is not a pattern to copy.

Usable as a boundary:

A deterministic adapter merge is outside this literature, so only a frozen-set score can accept it. An experimental editor may scale or remove one direction, or add a low-rank delta, in a named module, then keep or revert it on development passes only. Protected cases stay out of the prompt and the budget. That pass is not proof, and copy must not promise improvement. Show the forward-pass cap first; a cap below the blog's 50-pass setting is a different experiment. Sending weights to a hosted editor is a data-use choice the papers make and do not settle for a customer's allowed uses.

Untested: cross-architecture merges, third-party adapters, editing a LoRA without the base forward pass, license inheritance, multi-tenant data, and installing a missing skill.
