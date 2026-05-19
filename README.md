# Supertonic 3 ONNX Model Assets

Mirrored from <https://huggingface.co/Supertone/supertonic-3> for use by the deployed Arabic web demo.

`vector_estimator.onnx` is split into shards (`vector_estimator.part.{0..3}`)
because its 245 MB original size exceeds GitHub's 100 MB per-file limit. The
deployed app fetches all parts via `raw.githubusercontent.com` and concatenates
them back in the browser before passing to ONNX Runtime Web.
