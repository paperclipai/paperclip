;; Copyright 2015-2021 Mathieu Bernard
;;
;; This file is part of phonemizer: you can redistribute it and/or
;; modify it under the terms of the GNU General Public License as
;; published by the Free Software Foundation, either version 3 of the
;; License, or (at your option) any later version.
;;
;; Phonemizer is distributed in the hope that it will be useful, but
;; WITHOUT ANY WARRANTY; without even the implied warranty of
;; MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
;; General Public License for more details.
;;
;; You should have received a copy of the GNU General Public License
;; along with phonemizer. If not, see <http://www.gnu.org/licenses/>.

;; This script is executed by festival for English text phonemization.
(define (phonemize line)
  "(phonemize LINE)
Extract the phonemes of the string LINE as a tree and write it to stdout."
  (set! utterance (eval (list 'Utterance 'Text line)))
  (utt.synth utterance)
  ;; Use of print instead of pprintf to have each utterance on one line
  (print (utt.relation_tree utterance "SylStructure")))

;; This double braket have to be replaced by the name of the text file
;; you want to read data from. To be parsed by festival as a unique
;; utterance, each line of that file must begin and end with
;; double-quotes.
(set! lines (load "{}" t))
(mapcar (lambda (line) (phonemize line)) lines)
