"""
conftest.py — make the package importable without installing it.
"""
import sys
import os

# Insert the sdk/python directory so `import githubdb_sdk` works directly.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
