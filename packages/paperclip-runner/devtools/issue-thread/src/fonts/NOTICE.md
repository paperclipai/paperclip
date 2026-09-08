# Capability issue-thread fonts

The Capability issue-thread bundle includes Latin-subset WOFF2 files so captures
do not depend on fonts installed on the host.

## Inter

- Upstream: https://github.com/rsms/inter
- Version: 4.1
- Source: `ui/public/fonts/InterVariable.woff2`
- License: SIL Open Font License 1.1
- License text: https://github.com/rsms/inter/blob/v4.1/LICENSE.txt

The bundled file is subset from the repository's unmodified upstream Inter 4.1
variable WOFF2. CSS exposes weights 400 through 700.

## DejaVu Sans Mono

- Upstream: https://dejavu-fonts.github.io/
- Version: 2.37
- Source faces: DejaVu Sans Mono Book and Bold; DejaVu Sans Book for status glyphs
- License: Bitstream Vera Fonts license; DejaVu changes are public domain
- License text: https://dejavu-fonts.github.io/License.html

The bundled files are Latin subsets of the Book and Bold faces. The source font
copyright and permission notice follow.

> Copyright (c) 2003 by Bitstream, Inc. All Rights Reserved. Bitstream Vera is a
> trademark of Bitstream, Inc.
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of the fonts accompanying this license ("Fonts") and associated documentation
> files (the "Font Software"), to reproduce and distribute the Font Software,
> including without limitation the rights to use, copy, merge, publish,
> distribute, and/or sell copies of the Font Software, and to permit persons to
> whom the Font Software is furnished to do so, subject to the following
> conditions:
>
> The above copyright and trademark notices and this permission notice shall be
> included in all copies of one or more of the Font Software typefaces.
>
> The Font Software may be modified, altered, or added to, and in particular the
> designs of glyphs or characters in the Fonts may be modified and additional
> glyphs or characters may be added to the Fonts, only if the fonts are renamed
> to names not containing either the words "Bitstream" or the word "Vera".
>
> This License becomes null and void to the extent applicable to Fonts or Font
> Software that has been modified and is distributed under the "Bitstream Vera"
> names.
>
> The Font Software may be sold as part of a larger software package but no copy
> of one or more of the Font Software typefaces may be sold by itself.
>
> THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
> OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT,
> TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL BITSTREAM OR THE GNOME FOUNDATION
> BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING ANY GENERAL,
> SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, WHETHER IN AN ACTION
> OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF THE USE OR INABILITY TO
> USE THE FONT SOFTWARE OR FROM OTHER DEALINGS IN THE FONT SOFTWARE.
>
> Except as contained in this notice, the names of Gnome, the Gnome Foundation,
> and Bitstream Inc., shall not be used in advertising or otherwise to promote
> the sale, use or other dealings in the Font Software without prior written
> authorization from the Gnome Foundation or Bitstream Inc., respectively.

## Noto Sans Symbols 2

- Upstream: https://github.com/notofonts/symbols
- Version: 2.003
- Source face: Noto Sans Symbols 2 Regular
- License: SIL Open Font License 1.1
- License text: https://github.com/notofonts/symbols/blob/main/OFL.txt

The 1.2 kB bundled subset contains only the two hourglass glyphs that are not
present in Inter or DejaVu Sans. It is exposed under the same package-specific
symbol fallback family using a disjoint `unicode-range`.
