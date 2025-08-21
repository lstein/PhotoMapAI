# Contributing to PhotoMap

Thank you for your interest in contributing to PhotoMap!  
We welcome pull requests for bug fixes, new features, documentation improvements, and more.

## How to Contribute

1. **Fork the repository**  
   Click the "Fork" button at the top right of the GitHub page to create your own copy of the repository.

2. **Clone your fork**  
   ```sh
   git clone https://github.com/<your-username>/PhotoMap.git
   cd PhotoMap
   ```

3. **Create a new branch**  
   Use a descriptive name for your branch:
   ```sh
   git checkout -b feature/my-feature
   ```

4. **Make your changes**  
   - Install using `pip install -e.[testing,development]
   - Follow the existing code style and conventions.
   - Add or update tests as needed.
   - Document your code where appropriate.

5. **Run the tests**  
   Ensure all tests pass before submitting your pull request:
   ```sh
   pytest tests
   ```

6. **Commit your changes**  
   Write clear, concise commit messages:
   ```sh
   git add .
   git commit -m "Describe your changes"
   ```

7. **Push your branch to GitHub**  
   ```sh
   git push origin feature/my-feature
   ```

8. **Open a pull request**  
   - Go to your fork on GitHub.
   - Click "Compare & pull request".
   - Fill in the pull request template, describing your changes and referencing any related issues.

9. **Respond to feedback**  
   - Be ready to discuss and revise your code based on feedback from maintainers and reviewers.

## Pull Request Requirements

- All tests must pass (see [GitHub Actions](https://github.com/<your-username>/PhotoMap/actions)).
- Code should follow the project’s style and guidelines.
- Include relevant documentation and tests.
- Clearly describe your changes in the pull request.

## Code of Conduct

Please be respectful and constructive in all interactions.  
See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for details.

---

Thank you for helping improve PhotoMap!
