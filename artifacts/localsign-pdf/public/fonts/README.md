Place the Noto Sans SC regular TrueType font here as:

`NotoSansSC-Regular.ttf`

The PDF exporter loads this file locally and embeds only the glyphs used. If
the font is absent, English text uses pdf-lib's built-in Helvetica font; CJK
text is rendered to a transparent image with the browser's installed fonts to
avoid encoding errors.
