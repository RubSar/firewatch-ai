# ML progress update

Suggested placement: prototype progress slide. Speaking time: about 30 seconds.

We’ve now run NASA and IBM’s Prithvi model on a laptop NVIDIA GPU. In one test,
it processed a 512-by-512 satellite image in about 1.7 seconds and produced a map
of possible burned areas. Our next step is to test it on Cypress Creek imagery
and measure accuracy. This is an early burned-area result. Live fire detection
and spread tracking remain separate research steps.

Source for the presenter: [local execution evidence](../concurrent-analysis/09-observation-baseline/results/prithvi-local/README.md).
The timing covers model inference on one public example, not image acquisition
or an operational workflow. Cypress Creek evaluation is still pending.
