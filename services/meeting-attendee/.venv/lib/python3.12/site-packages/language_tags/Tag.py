# -*- coding: utf-8 -*-
import json


from language_tags.Subtag import Subtag
from language_tags import data


index = data.get('index')
registry = data.get('registry')


class Tag:
    def __init__(self, tag):
        # Lowercase for consistency (case is only a formatting convention, not a standard requirement).
        """
        Tags for Identifying Languages based on BCP 47 (RFC 5646) and the latest IANA language subtag registry.

        :param str tag: (hyphen-separated) tag.
        """
        tag = str(tag).strip().lower()

        self.data = {'tag': tag}

        if tag in index:
            types = index[tag]
            # Check if the input tag is grandfathered or redundant.
            if 'grandfathered' in types or 'redundant' in types:
                self.data['record'] = registry[types['grandfathered']] if 'grandfathered' in types \
                    else registry[types['redundant']]

        # Include errror codes
        self.ERR_DEPRECATED = 1
        self.ERR_NO_LANGUAGE = 2
        self.ERR_UNKNOWN = 3
        self.ERR_TOO_LONG = 4
        self.ERR_EXTRA_REGION = 5
        self.ERR_EXTRA_EXTLANG = 6
        self.ERR_EXTRA_SCRIPT = 7
        self.ERR_DUPLICATE_VARIANT = 8
        self.ERR_WRONG_ORDER = 9
        self.ERR_SUPPRESS_SCRIPT = 10
        self.ERR_SUBTAG_DEPRECATED = 11
        self.ERR_EXTRA_LANGUAGE = 12

    def __str__(self):
        return self.format

    def __repr__(self):
        return json.dumps(self.data, ensure_ascii=False)

    @property
    def preferred(self):
        """
        Get the preferred :class:`language_tags.Tag.Tag` of the deprecated or redundant tag.

        :return: preferred :class:`language_tags.Tag.Tag` if the deprecated or redundant tag has one, otherwise None.
        """
        if 'record' in self.data:
            return Tag(self.data['record']['Preferred-Value']) if 'Preferred-Value' in self.data['record'] else None
        else:
            return None

    @property
    def type(self):
        """
        Get the type of the tag (either grandfathered, redundant or tag see RFC 5646 section 2.2.8.).

        :return: string -- type of the tag.
        """
        if 'record' in self.data:
            return self.data['record']['Type']
        return 'tag'

    @property
    def added(self):
        """
        Get the date string of grandfathered or redundant tag when it was added to the registry.

        :return: added date string if the deprecated or redundant tag has one, otherwise None.
        """
        if 'record' in self.data:
            return self.data['record']['Added'] if 'Added' in self.data['record'] else None
        else:
            return None

    @property
    def deprecated(self):
        """
        Get the deprecation date of grandfathered or redundant tag if the tag is deprecated.

        :return: deprecation date string if the deprecated or redundant tag has one, otherwise None.
        """
        if 'record' in self.data:
            return self.data['record']['Deprecated'] if 'Deprecated' in self.data['record'] else None
        else:
            return None

    @property
    def descriptions(self):
        """
        Get the list of descriptions of the grandfathered or redundant tag.

        :return: list of descriptions. If no descriptions available, it returns an empty list.
        """
        if 'record' in self.data:
            return self.data['record']['Description'] if 'Description' in self.data['record'] else []
        else:
            return []

    @property
    def format(self):
        """
        Get format according to algorithm defined in RFC 5646 section 2.1.1.


        :return: formatted tag string.
        """
        tag = self.data['tag']
        subtags = tag.split('-')
        if len(subtags) == 1:
            return subtags[0]

        formatted_tag = subtags[0]
        private_tag = False
        for i, subtag in enumerate(subtags[1:]):

            if len(subtags[i]) == 1 or private_tag:
                formatted_tag += '-' + subtag
                private_tag = True

            elif len(subtag) == 2:
                formatted_tag += '-' + subtag.upper()

            elif len(subtag) == 4:
                formatted_tag += '-' + subtag.capitalize()
            else:
                formatted_tag += '-' + subtag

        return formatted_tag

    @property
    def subtags(self):
        """
        Get the :class:`language_tags.Subtag.Subtag` objects of the tag.

        :return: list of :class:`language_tags.Subtag.Subtag` objects that are part of the tag.
            The return list can be empty.
        """
        data = self.data
        subtags = []

        # if tag is grandfathered return no subtags
        if 'record' in data and self.data['record']['Type'] == 'grandfathered':
            return subtags

        codes = data['tag'].split('-')
        # Try and find the language tag.
        for i, code in enumerate(codes):

            # Singletons and anything after are unhandled.
            if len(code) == 1:
                #Stop the loop (stop processing after a singleton).
                break

            # Check for non-existent tag.
            if code not in index:
                continue
            types = index[code]

            # Language subtags may only appear at the beginning of the tag, otherwise the subtag type is indeterminate.
            if 'language' in types and i == 0:
                subtags.append(Subtag(code, 'language'))
                continue

            if len(code) == 2:
                # Should be a region
                if 'region' in types:
                    subtags.append(Subtag(code, 'region'))
                # Error case: language subtag in the wrong place.
                elif 'language' in types:
                    subtags.append(Subtag(code, 'language'))

            elif len(code) == 3:
                # Could be a numeric region code e.g. '001' for 'World'.
                if 'region' in types:
                    subtags.append(Subtag(code, 'region'))
                elif 'extlang' in types:
                    subtags.append(Subtag(code, 'extlang'))
                # Error case: language subtag in the wrong place.
                elif 'language' in types:
                    subtags.append(Subtag(code, 'language'))

            elif len(code) == 4:
                # Could be a numeric variant
                if 'variant' in types:
                    subtags.append(Subtag(code, 'variant'))
                elif 'script' in types:
                    subtags.append(Subtag(code, 'script'))

            else:
                # Should be a variant
                if 'variant' in types:
                    subtags.append(Subtag(code, 'variant'))

        return subtags

    @property
    def language(self):
        """
        Get the language :class:`language_tags.Subtag.Subtag` of the tag.

        :return: language :class:`language_tags.Subtag.Subtag` that is part of the tag.
            The return can be None.
        """

        language_item = [subtag for subtag in self.subtags if subtag.type == 'language']

        return language_item[0] if len(language_item) > 0 else None

    @property
    def region(self):
        """
        Get the region :class:`language_tags.Subtag.Subtag` of the tag.

        :return: region :class:`language_tags.Subtag.Subtag` that is part of the tag.
            The return can be None.
        """

        region_item = [subtag for subtag in self.subtags if subtag.type == 'region']

        return region_item[0] if len(region_item) > 0 else None


    @property
    def script(self):
        """
        Get the script :class:`language_tags.Subtag.Subtag` of the tag.

        :return: script :class:`language_tags.Subtag.Subtag` that is part of the tag.
            The return can be None.
        """
        script_item = [subtag for subtag in self.subtags if subtag.type == 'script']

        return script_item[0] if len(script_item) > 0 else None

    @property
    def valid(self):
        """
        Checks whether the tag is valid.

        :return: Bool -- True if valid otherwise False.
        """
        return len(self.errors) < 1

    @property
    def errors(self):
        """
        Get the errors of the tag.
        If invalid then the list will consist of errors containing each a code and message explaining the error.
        Each error also refers to the respective (sub)tag(s).

        :return: list of errors of the tag. If the tag is valid, it returns an empty list.
        """
        errors = []
        data = self.data
        error = self.error

        # Check if the tag is grandfathered and if the grandfathered tag is deprecated (e.g. no-nyn).
        if 'record' in data:
            if 'Deprecated' in data['record']:
                errors.append(error(self.ERR_DEPRECATED))
            # Only check every subtag if the tag is not explicitly listed as grandfathered or redundant.
            return errors

        # Check that all subtag codes are meaningful.
        codes = data['tag'].split('-')
        for i, code in enumerate(codes):
            # Ignore anything after a singleton (break)
            if len(code) < 2:
                # Check that each private-use subtag is within the maximum allowed length.
                for code in codes[i + 1:]:
                    if len(code) > 8:
                        errors.append(error(self.ERR_TOO_LONG, code))
                break

            if code not in index:
                errors.append(error(self.ERR_UNKNOWN, code))
                # Continue to the next item.
                continue

        # Check that first tag is a language tag.
        subtags = self.subtags
        if not len(subtags):
            errors.append(error(self.ERR_NO_LANGUAGE))
            return errors
        elif subtags[0].type != 'language':
            errors.append(error(self.ERR_NO_LANGUAGE))
            return errors

        # Check for more than one of some types and for deprecation.
        found = dict(language=[], extlang=[], variant=[], script=[], region=[])
        for subtag in subtags:
            type = subtag.type

            if subtag.deprecated:
                errors.append(error(self.ERR_SUBTAG_DEPRECATED, subtag))

            if type in found:
                found[type].append(subtag)

            if 'language' == type:
                if len(found['language']) > 1:
                    errors.append(error(self.ERR_EXTRA_LANGUAGE, subtag))
            elif 'region' == type:
                if len(found['region']) > 1:
                    errors.append(error(self.ERR_EXTRA_REGION, subtag))
            elif 'extlang' == type:
                if len(found['extlang']) > 1:
                    errors.append(error(self.ERR_EXTRA_EXTLANG, subtag))
            elif 'script' == type:
                if len(found['script']) > 1:
                    errors.append(error(self.ERR_EXTRA_SCRIPT, subtag))
                # Check if script is same as language suppress-script.
                else:
                    script = subtags[0].script
                    if script:
                        if script.format == subtag.format:
                            errors.append(error(self.ERR_SUPPRESS_SCRIPT, subtag))
            elif 'variant' == type:
                if len(found['variant']) > 1:
                    for variant in found['variant']:
                        if variant.format == subtag.format:
                            errors.append(error(self.ERR_DUPLICATE_VARIANT, subtag))
                            break

        # Check for correct order.
        if len(subtags) > 1:
            priority = dict(language=4, extlang=5, script=6, region=7, variant=8)
            for i, subtag in enumerate(subtags[0:len(subtags)-1]):
                next = subtags[i + 1]
                if next:
                    if priority[subtag.type] > priority[next.type]:
                        errors.append(error(self.ERR_WRONG_ORDER, [subtag, next]))

        return errors

    def error(self, code, subtag=None):
        """
        Get the :class:`language_tags.Tag.Tag.Error` of a specific Tag error code.
        The error creates a message explaining the error.
        It also refers to the respective (sub)tag(s).

        :param int code: a Tag error error:

            * 1 = Tag.ERR_DEPRECATED
            * 2 = Tag.ERR_NO_LANGUAGE
            * 3 = Tag.ERR_UNKNOWN,
            * 4 = Tag.ERR_TOO_LONG
            * 5 = Tag.ERR_EXTRA_REGION
            * 6 = Tag.ERR_EXTRA_EXTLANG
            * 7 = Tag.ERR_EXTRA_SCRIPT,
            * 8 = Tag.ERR_DUPLICATE_VARIANT
            * 9 = Tag.ERR_WRONG_ORDER
            * 10 = Tag.ERR_SUPPRESS_SCRIPT,
            * 11 = Tag.ERR_SUBTAG_DEPRECATED
            * 12 = Tag.ERR_EXTRA_LANGUAGE

        :param subtag: string (sub)tag or list of string (sub)tags creating the error.
        :return: An exception class containing: a Tag error input code, the derived message with the given (sub)tag(s).
            input
        """
        message = ""
        data = self.data

        if code == self.ERR_DEPRECATED:
            message = 'The tag %s is deprecated.' % data['tag']

            # Note that a record that contains a 'Deprecated' field and no corresponding 'Preferred-Value' field
            # has no replacement mapping (RFC 5646 section 3.1.6).
            if 'Preferred-Value' in self.data['record']:
                message += ' Use \'%s\' instead.' % data['record']['Preferred-Value']

        elif code == self.ERR_SUBTAG_DEPRECATED:
            message = 'The subtag \'%s\' is deprecated.' % subtag.format

        elif code == self.ERR_NO_LANGUAGE:
            if not len(data['tag']):
                message = 'Empty tag.'
            else:
                message = 'Missing language tag in \'%s\'.' % data['tag']

        elif code == self.ERR_UNKNOWN:
            message = 'Unknown code \'%s\'' % subtag

        elif code == self.ERR_TOO_LONG:
            message = 'The private-use subtag \'%s\' is too long.' % subtag

        elif code in [self.ERR_EXTRA_LANGUAGE,
                    self.ERR_EXTRA_EXTLANG,
                    self.ERR_EXTRA_REGION,
                    self.ERR_EXTRA_SCRIPT]:
            message = 'Extra %s subtag \'%s\' found.' % (subtag.type, subtag.format)

        elif code == self.ERR_DUPLICATE_VARIANT:
            message = 'Duplicate variant subtag \'%s\' found.' % subtag.format

        elif code == self.ERR_WRONG_ORDER:
            message = 'The subtag \'%s\' should not appear before \'%s\'.' % (subtag[0].format, subtag[1].format)

        elif code == self.ERR_SUPPRESS_SCRIPT:
            message = 'The script subtag \'%s\' is the same as the language suppress-script.' % subtag.format

        class Error(Exception):
            def __init__(self, code, message, tag, subtag):
                self.code = code
                self.message = message
                self.tag = tag
                self.subtag = subtag.format if isinstance(subtag, Subtag) else subtag

            def __str__(self):
                return repr("%s: %s (Tag %s; Subtag %s)" % (self.code, self.message, self.tag, str(self.subtag)))

        return Error(code, message, data['tag'], subtag)
