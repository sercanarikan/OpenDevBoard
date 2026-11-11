import re
import unittest
from pathlib import Path


class ConstraintLockTests(unittest.TestCase):
    def test_constraints_pin_every_requirement_and_include_transitives(self):
        root = Path(__file__).resolve().parent
        requirements = [
            line.strip().split(';', 1)[0].split('[', 1)[0].lower().replace('_', '-')
            for line in (root / 'requirements.txt').read_text().splitlines()
            if line.strip() and not line.lstrip().startswith('#')
        ]
        pins = {}
        for line in (root / 'constraints.txt').read_text().splitlines():
            match = re.fullmatch(r'([A-Za-z0-9_.-]+)==([^\s]+)', line.strip())
            self.assertIsNotNone(match, f'constraint must be exact name==version: {line}')
            pins[match.group(1).lower().replace('_', '-')] = match.group(2)
        self.assertEqual(len(pins), len((root / 'constraints.txt').read_text().splitlines()))
        self.assertTrue(set(requirements).issubset(pins))
        self.assertGreater(len(pins), len(requirements), 'transitive dependencies must be locked too')


if __name__ == '__main__':
    unittest.main()
