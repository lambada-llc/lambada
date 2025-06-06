## Examples

``` bash
# Emit function that generates an app config from the emit-json example
cat ../examples/emit-json.lamb | ./compile.sh '\bucket_id to_string $ generate_app_config bucket_id' > /tmp/generate_app_config.dag
# Generate some app configs
node ./tree-calculus.js -dag -file /tmp/generate_app_config.dag -string foo
node ./tree-calculus.js -dag -file /tmp/generate_app_config.dag -string some_much_longer_bucket_id
```

``` bash
# Compile the portability example and evaluate the translation of the example_program into bash
cat ../examples/portability.lamb | ./compile.sh 'to_bash example_program' > /tmp/example_program.dag
# Extract and store bash script from dag
node ./tree-calculus.js -dag -file /tmp/example_program.dag -string > /tmp/example_program.sh
chmod +x /tmp/example_program.sh
# Test that bash script indeed behaves like example_program
echo -n nonsense | /tmp/example_program.sh; echo
echo -n secret | /tmp/example_program.sh; echo
```

## Changelog

The LambAda "language" and compiler have been developed on and off over years, turning out useful over and over again during calculus explorations:

* 2012: First version of LambAda created for [this project](https://lambada.pages.dev/) that experiments with bootstrapping a language from the [Iota combinator](https://en.wikipedia.org/wiki/Iota_and_Jot). LambAda compiler and Iota runtime written in C# and transpiled to JavaScript using [Script#](https://github.com/nikhilk/scriptsharp). The only conveniences LambAda provides at this point are assignments and abstraction elimination.
* 2013: Support for number and string constants added. Support for algebraic data type definitions added. Rewriting the LambAda compiiler in LambAda. Support for list syntax added as first LambAda feature written only in LambAda. Experiments with structure editing.
* 2014: Reading papers and performing various experiments related to type systems. (None of the results have been baked into LambAda so far.)
* 2015: Migrating code from OneDrive to GitHub, rewriting Iota runtime from C# to TypeScript.
* 2016: Starting to use VSCode instead of Visual Studio.
* 2017-2022: Maintenance mode and various tweaks, formalizing thoughts, attempts to reduce runtime further. Post about [one-point bases for λ-calculus](https://olydis.medium.com/one-point-bases-for-%CE%BB-calculus-4163b1b326ad).
* 2023: Coming across Barry Jay's tree calculus in search of a smaller and more principled foundation. Updating runtimes to execute tree calculus instead of Iota (first by literally defining Iota in terms of tree nodes). Gradually rewriting LambAda compiler to emit more canonical trees and making use of tree calculus features directly. Result is significantly faster, presumably predominatly due to more efficient data representations (in terms of reduction steps necessary to manipulate or branch based on).
* 2024: Launching the [tree calculus playground](https://treecalcul.us/live/) with LambAda and writing a load of tree calculus demos using it.
* 2025: Creating this public repo to make the various demos written in LambAda more widely accessible.
