package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
)

type constraint struct {
	Type     string   `json:"type"`
	Values   []string `json:"values"`
	Minimum  *int64   `json:"minimum"`
	Maximum  *int64   `json:"maximum"`
	Registry string   `json:"registry"`
}

type property struct {
	Name       string     `json:"name"`
	Required   *bool      `json:"required"`
	Constraint constraint `json:"constraint"`
}

type event struct {
	Name                 string     `json:"name"`
	AdditionalProperties *bool      `json:"additionalProperties"`
	Properties           []property `json:"properties"`
}

type grammar struct {
	Artifact         string  `json:"artifact"`
	FormatVersion    int     `json:"formatVersion"`
	AdditionalEvents *bool   `json:"additionalEvents"`
	Events           []event `json:"events"`
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, "FAIL:", message)
	os.Exit(1)
}

func propertyNamed(properties []property, name string) property {
	for _, candidate := range properties {
		if candidate.Name == name {
			return candidate
		}
	}
	fail("missing property " + name)
	return property{}
}

func decodeGrammar(path string) grammar {
	file, err := os.Open(path)
	if err != nil {
		fail(err.Error())
	}
	defer file.Close()

	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	var document grammar
	if err := decoder.Decode(&document); err != nil {
		fail(err.Error())
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		fail("grammar has trailing JSON data")
	}
	return document
}

func validateEnvelope(document grammar) event {
	if document.Artifact != "react-native-nitro-logger/analytics-grammar" || document.FormatVersion != 1 {
		fail("wrong grammar discriminator or format version")
	}
	if document.AdditionalEvents == nil || *document.AdditionalEvents {
		fail("additionalEvents must be present and false")
	}
	if len(document.Events) != 1 || document.Events[0].Name != "unicode_probe" {
		fail("unexpected event set")
	}
	probe := document.Events[0]
	if probe.AdditionalProperties == nil || *probe.AdditionalProperties {
		fail("additionalProperties must be present and false")
	}
	return probe
}

func validateProbeEvent(probe event) {
	value := propertyNamed(probe.Properties, "value")
	wantValues := []string{"plain", "🚀", "e\u0301", "\ufffd"}
	if value.Required == nil || !*value.Required || value.Constraint.Type != "enum" || len(value.Constraint.Values) != len(wantValues) {
		fail("unexpected enum constraint")
	}
	for index, want := range wantValues {
		if value.Constraint.Values[index] != want {
			fail(fmt.Sprintf("Unicode member %d changed during decode", index))
		}
	}

	bounded := propertyNamed(probe.Properties, "bounded")
	if bounded.Constraint.Type != "integer" || bounded.Constraint.Minimum == nil || bounded.Constraint.Maximum == nil || *bounded.Constraint.Minimum != -9007199254740991 || *bounded.Constraint.Maximum != 9007199254740991 {
		fail("integer bounds changed during decode")
	}
	named := propertyNamed(probe.Properties, "named")
	if named.Constraint.Type != "named-string" || named.Constraint.Registry != "sample-registry" || len(named.Constraint.Values) != 1 || named.Constraint.Values[0] != "registered" {
		fail("named-string registry changed during decode")
	}
}

func main() {
	if len(os.Args) != 2 {
		fail("usage: analytics-grammar-decode <grammar.json>")
	}

	document := decodeGrammar(os.Args[1])
	probe := validateEnvelope(document)
	validateProbeEvent(probe)

	fmt.Println("ok: TypeScript grammar decoded losslessly in Go")
}
